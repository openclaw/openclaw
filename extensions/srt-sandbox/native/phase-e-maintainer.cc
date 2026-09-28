// Phase E runs in this Node process only: no child process, task, service, COM
// server, or helper is created by this addon.
#ifdef _WIN32
#include <node_api.h>
#include <windows.h>
#include <lm.h>
#include <fwpmu.h>
#include <wincrypt.h>
#include <sddl.h>
#include <vector>
#include <set>
#include <cstring>
#include <string>
#pragma comment(lib, "netapi32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "crypt32.lib")

constexpr wchar_t kPool[][10] = {L"srt-w0-01",L"srt-w0-02",L"srt-w0-03",L"srt-w0-04",L"srt-w0-05",L"srt-w0-06",L"srt-w0-07",L"srt-w0-08"};
struct Account { std::wstring name, sid; };
static bool Canonical(const std::wstring& n) { for (auto& p : kPool) if (n == p) return true; return false; }
static std::wstring Sid(PSID sid) { LPWSTR value=nullptr; std::wstring out; if (sid && ConvertSidToStringSidW(sid,&value)) { out=value; LocalFree(value); } return out; }
static bool GetAccount(const wchar_t* name, Account* account) {
  LPBYTE raw=nullptr; NET_API_STATUS status=NetUserGetInfo(nullptr,name,4,&raw);
  if (status==NERR_UserNotFound) return false;
  if (status!=NERR_Success) throw std::string("PHASE_E_NETUSER_QUERY_FAILED");
  auto* info=reinterpret_cast<USER_INFO_4*>(raw); account->name=name; account->sid=Sid(info->usri4_user_sid); NetApiBufferFree(raw);
  if(account->sid.empty()) throw std::string("PHASE_E_SID_RESOLUTION_FAILED"); return true;
}
static std::vector<Account> Inspect(size_t* legacy) {
  std::vector<Account> result; *legacy=0; DWORD read=0,total=0,resume=0; LPUSER_INFO_0 users=nullptr;
  do { NET_API_STATUS status=NetUserEnum(nullptr,0,FILTER_NORMAL_ACCOUNT,reinterpret_cast<LPBYTE*>(&users),MAX_PREFERRED_LENGTH,&read,&total,&resume);
    if(status!=NERR_Success && status!=ERROR_MORE_DATA) throw std::string("PHASE_E_NETUSER_ENUM_FAILED");
    for(DWORD i=0;i<read;i++){ std::wstring name(users[i].usri0_name); if(name.rfind(L"srt-",0)!=0) continue; if(!Canonical(name)){++*legacy; continue;} Account account; GetAccount(name.c_str(),&account); result.push_back(account); }
    if(users){NetApiBufferFree(users);users=nullptr;} if(status==NERR_Success) break;
  }while(true);
  std::set<std::wstring> sids; for(auto& account:result) if(!sids.insert(account.sid).second) throw std::string("PHASE_E_NAMESPACE_AMBIGUOUS");
  if(!result.empty() && result.size()!=8) throw std::string("PHASE_E_NAMESPACE_AMBIGUOUS"); return result;
}
static void CheckPrerequisites() {
  SC_HANDLE scm=OpenSCManagerW(nullptr,nullptr,SC_MANAGER_CONNECT); if(!scm) throw std::string("PHASE_E_SCM_UNAVAILABLE");
  SC_HANDLE service=OpenServiceW(scm,L"seclogon",SERVICE_QUERY_STATUS); if(service) CloseServiceHandle(service); CloseServiceHandle(scm);
  HANDLE root=CreateFileW(L"C:\\ProgramData\\srt-sandbox",READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(root!=INVALID_HANDLE_VALUE){ BY_HANDLE_FILE_INFORMATION info{}; BOOL ok=GetFileInformationByHandle(root,&info); CloseHandle(root); if(!ok || (info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)) throw std::string("PHASE_E_REPARSE_DETECTED"); }
  HANDLE engine=nullptr; if(FwpmEngineOpen0(nullptr,RPC_C_AUTHN_WINNT,nullptr,nullptr,&engine)!=ERROR_SUCCESS) throw std::string("PHASE_E_FWPM_OPEN_FAILED"); FwpmEngineClose0(engine);
  DWORD probe=GetCurrentProcessId(); DATA_BLOB plain{sizeof probe,reinterpret_cast<BYTE*>(&probe)},sealed{}; if(!CryptProtectData(&plain,L"srt-phase-e",nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&sealed)) throw std::string("PHASE_E_DPAPI_SEAL_FAILED"); LocalFree(sealed.pbData);
}
static void CreatePool() {
  size_t legacy; auto prior=Inspect(&legacy); if(!prior.empty()) throw std::string("PHASE_E_NAMESPACE_AMBIGUOUS"); std::vector<std::wstring> made;
  try { for(auto& name:kPool){ USER_INFO_1 user{}; user.usri1_name=const_cast<wchar_t*>(name); user.usri1_priv=USER_PRIV_USER; user.usri1_flags=UF_SCRIPT|UF_DONT_EXPIRE_PASSWD; DWORD parameter=0; if(NetUserAdd(nullptr,1,reinterpret_cast<LPBYTE>(&user),&parameter)!=NERR_Success) throw std::string("PHASE_E_ACCOUNT_CREATE_FAILED"); made.push_back(name); } size_t ignored; if(Inspect(&ignored).size()!=8) throw std::string("PHASE_E_POSTCONDITION_FAILED"); CheckPrerequisites(); }
  catch(...) { for(auto& name:made) NetUserDel(nullptr,name.c_str()); throw; }
}
static std::string Evidence(const char* mode,const char* outcome,const std::vector<Account>& accounts,size_t legacy) {
  std::string list; for(size_t i=0;i<accounts.size();++i){ if(i) list+=','; std::string name(accounts[i].name.begin(),accounts[i].name.end()),sid(accounts[i].sid.begin(),accounts[i].sid.end()); list+="{\"name\":\""+name+"\",\"sid\":\""+sid+"\"}"; }
  return std::string("{\"schema\":\"phase-e-evidence/v1\",\"mode\":\"")+mode+"\",\"outcome\":\""+outcome+"\",\"maintainer\":{\"pid\":"+std::to_string(GetCurrentProcessId())+",\"creationTime\":\"native-process\"},\"canonicalAccounts\":["+list+"],\"legacyAccountCount\":"+std::to_string(legacy)+",\"seclogon\":\"UNKNOWN\",\"manifestGeneration\":0}";
}
static napi_value Run(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) return nullptr;
  char mode[16] = {}; size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], mode, sizeof(mode), &length) != napi_ok) return nullptr;
  const bool valid = !strcmp(mode, "preflight") || !strcmp(mode, "setup") || !strcmp(mode, "repair") || !strcmp(mode, "rollback") || !strcmp(mode, "teardown");
  if (!valid) { napi_throw_error(env, "PHASE_E_INVALID_MODE", "invalid mode"); return nullptr; }
  try { size_t legacy=0; auto accounts=Inspect(&legacy); const char* outcome="PREFLIGHT_OK";
    if(!strcmp(mode,"setup")){ CreatePool(); accounts=Inspect(&legacy); outcome="SETUP_COMPLETE"; }
    else if(!strcmp(mode,"repair")){ if(accounts.empty()) CreatePool(); else CheckPrerequisites(); accounts=Inspect(&legacy); outcome="REPAIR_COMPLETE"; }
    else if(!strcmp(mode,"rollback")||!strcmp(mode,"teardown")){ throw std::string("PHASE_E_MANIFEST_REQUIRED"); }
    std::string result=Evidence(mode,outcome,accounts,legacy); napi_value out; napi_create_string_utf8(env,result.c_str(),result.size(),&out); return out;
  } catch(const std::string& error) { napi_throw_error(env,error.c_str(),error.c_str()); return nullptr; }
}
static napi_value Init(napi_env env, napi_value exports) { napi_value run; napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &run); napi_set_named_property(env, exports, "run", run); return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
