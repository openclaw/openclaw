// Phase E runs in this Node process only: no child process, task, service, COM
// server, or helper is created by this addon.
#ifdef _WIN32
#include <node_api.h>
#include <windows.h>
#include <lm.h>
#include <fwpmu.h>
#include <wincrypt.h>
#include <sddl.h>
#include <aclapi.h>
#include <vector>
#include <set>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <string>
#include <algorithm>
#pragma comment(lib, "netapi32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "crypt32.lib")

constexpr wchar_t kPool[][10] = {L"srt-w0-01",L"srt-w0-02",L"srt-w0-03",L"srt-w0-04",L"srt-w0-05",L"srt-w0-06",L"srt-w0-07",L"srt-w0-08"};
constexpr wchar_t kRoot[] = L"C:\\ProgramData\\srt-sandbox";
constexpr wchar_t kManifest[] = L"C:\\ProgramData\\srt-sandbox\\phase-e.manifest.dpapi";
constexpr wchar_t kStore[] = L"C:\\ProgramData\\srt-sandbox\\lease-store.json";
constexpr wchar_t kLock[] = L"C:\\ProgramData\\srt-sandbox\\lease-store.lock";
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
static void WriteAll(HANDLE file,const std::string& text) { DWORD written=0; if(!WriteFile(file,text.data(),static_cast<DWORD>(text.size()),&written,nullptr)||written!=text.size()||!FlushFileBuffers(file)) throw std::string("PHASE_E_STORE_WRITE_FAILED"); }
// Security is applied and inspected through an already-open handle.  Paths are
// never re-opened after mutation, which keeps the reparse check meaningful.
static void NormalizeOwnedSecurity(HANDLE object) {
  PSECURITY_DESCRIPTOR descriptor=nullptr;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(
       L"O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)S:(ML;;NW;;;HI)", SDDL_REVISION_1, &descriptor, nullptr))
    throw std::string("PHASE_E_ACL_BUILD_FAILED");
  PACL dacl=nullptr; BOOL present=FALSE, defaulted=FALSE;
  if(!GetSecurityDescriptorDacl(descriptor,&present,&dacl,&defaulted) || !present || !dacl) { LocalFree(descriptor); throw std::string("PHASE_E_ACL_BUILD_FAILED"); }
  DWORD status=SetSecurityInfo(object,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,nullptr,nullptr,dacl,nullptr);
  LocalFree(descriptor); if(status!=ERROR_SUCCESS) throw std::string("PHASE_E_ACL_SET_FAILED");
  PSECURITY_DESCRIPTOR actual=nullptr; PACL actualDacl=nullptr; PSID owner=nullptr;
  status=GetSecurityInfo(object,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,&owner,nullptr,&actualDacl,nullptr,&actual);
  if(status!=ERROR_SUCCESS || !actual || !owner || !actualDacl || !IsValidSid(owner)) { if(actual)LocalFree(actual); throw std::string("PHASE_E_ACL_VERIFY_FAILED"); }
  SECURITY_DESCRIPTOR_CONTROL control=0; DWORD revision=0; bool protectedDacl=GetSecurityDescriptorControl(actual,&control,&revision) && (control&SE_DACL_PROTECTED);
  LocalFree(actual); if(!protectedDacl) throw std::string("PHASE_E_ACL_VERIFY_FAILED");
}
static HANDLE OpenSafe(const wchar_t* path,DWORD disposition) { HANDLE file=CreateFileW(path,GENERIC_READ|GENERIC_WRITE,0,nullptr,disposition,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(file==INVALID_HANDLE_VALUE) throw std::string("PHASE_E_STORE_OPEN_FAILED"); BY_HANDLE_FILE_INFORMATION info{}; if(!GetFileInformationByHandle(file,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(file);throw std::string("PHASE_E_REPARSE_DETECTED");} return file; }
static void EnsureSafeRoot() { if(!CreateDirectoryW(kRoot,nullptr)&&GetLastError()!=ERROR_ALREADY_EXISTS) throw std::string("PHASE_E_ROOT_CREATE_FAILED"); HANDLE root=CreateFileW(kRoot,READ_CONTROL|WRITE_DAC|WRITE_OWNER,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(root==INVALID_HANDLE_VALUE) throw std::string("PHASE_E_ROOT_OPEN_FAILED"); BY_HANDLE_FILE_INFORMATION info{}; BOOL ok=GetFileInformationByHandle(root,&info); if(!ok||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(root);throw std::string("PHASE_E_REPARSE_DETECTED");} NormalizeOwnedSecurity(root); CloseHandle(root); }
static std::string Hex(const BYTE* data,DWORD length) { static const char digits[]="0123456789abcdef"; std::string out; out.reserve(length*2); for(DWORD i=0;i<length;i++){out+=digits[data[i]>>4];out+=digits[data[i]&15];}return out; }
// This deliberately mirrors the small deterministic checksum used by the
// TypeScript policy layer.  It is an integrity tripwire, not a secret-bearing
// MAC: the surrounding DPAPI manifest is the ownership authorization record.
static std::string LeaseCrc(unsigned generation,const std::vector<std::string>& facts) { uint32_t value=0x811c9dc5u; std::string input="phase-e-v1:"+std::to_string(generation)+":"; for(size_t i=0;i<facts.size();++i){if(i)input+=',';input+=facts[i];} for(unsigned char byte:input)value=(value^byte)*0x01000193u; char out[9]={}; sprintf_s(out,sizeof out,"%08x",value); return out; }
static std::vector<BYTE> Unhex(const std::string& value) { if(value.empty() || value.size()%2) throw std::string("PHASE_E_MANIFEST_INVALID"); std::vector<BYTE> bytes; bytes.reserve(value.size()/2); for(size_t i=0;i<value.size();i+=2){ auto nibble=[](char c)->int { if(c>='0'&&c<='9')return c-'0'; if(c>='a'&&c<='f')return c-'a'+10; throw std::string("PHASE_E_MANIFEST_INVALID"); }; bytes.push_back(static_cast<BYTE>((nibble(value[i])<<4)|nibble(value[i+1]))); } return bytes; }
static std::string ReadAll(HANDLE file) { LARGE_INTEGER size{}; if(!GetFileSizeEx(file,&size)||size.QuadPart<=0||size.QuadPart>1024*1024)throw std::string("PHASE_E_MANIFEST_INVALID"); std::string text(static_cast<size_t>(size.QuadPart),0); DWORD read=0; if(!ReadFile(file,&text[0],static_cast<DWORD>(text.size()),&read,nullptr)||read!=text.size())throw std::string("PHASE_E_MANIFEST_READ_FAILED"); return text; }
static bool ContainsAccountFact(const std::string& json,const Account& account) { std::string name(account.name.begin(),account.name.end()); return json.find("\"name\":\""+name+"\"")!=std::string::npos && json.find("\"sid\":\""+account.sid+"\"")!=std::string::npos; }
// This authorization check deliberately accepts no partial or name-only state.
// The DPAPI blob is opened reparse-safely and is usable only by the maintainer's
// user context; it is not a general-purpose credential or manifest parser.
static void VerifyPersistedOwnership(const std::vector<Account>& accounts) { HANDLE manifest=OpenSafe(kManifest,OPEN_EXISTING); std::string encoded=ReadAll(manifest); CloseHandle(manifest); auto bytes=Unhex(encoded); DATA_BLOB sealed{static_cast<DWORD>(bytes.size()),bytes.data()},plain{}; if(!CryptUnprotectData(&sealed,nullptr,nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&plain))throw std::string("PHASE_E_MANIFEST_UNSEAL_FAILED"); std::string json(reinterpret_cast<char*>(plain.pbData),plain.cbData); SecureZeroMemory(plain.pbData,plain.cbData); LocalFree(plain.pbData); if(json.find("\"version\":1") == std::string::npos || json.find("\"owner\":\"srt-phase-e-maintainer\"") == std::string::npos || accounts.size()!=8)throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); for(const auto& account:accounts)if(!Canonical(account.name)||!ContainsAccountFact(json,account))throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); }
static void PersistOwnedState(const std::vector<Account>& accounts) { EnsureSafeRoot(); std::vector<std::string> accountFacts, sidFacts; for(const auto& account:accounts){std::string name(account.name.begin(),account.name.end());accountFacts.push_back(name+":"+account.sid);sidFacts.push_back(account.sid);} std::sort(accountFacts.begin(),accountFacts.end()); std::string json="{\"version\":1,\"generation\":1,\"owner\":\"srt-phase-e-maintainer\",\"invocationId\":\"phase-e-generation-1\",\"createdAccounts\":["; for(size_t i=0;i<accounts.size();i++){if(i)json+=',';json+="{\"name\":\""+std::string(accounts[i].name.begin(),accounts[i].name.end())+"\",\"sid\":\""+accounts[i].sid+"\"}";} json+= "],\"crc32\":\""+LeaseCrc(1,accountFacts)+"\"}"; DATA_BLOB plain{static_cast<DWORD>(json.size()),reinterpret_cast<BYTE*>(&json[0])},sealed{}; if(!CryptProtectData(&plain,L"srt-phase-e-manifest",nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&sealed))throw std::string("PHASE_E_DPAPI_SEAL_FAILED"); HANDLE manifest=OpenSafe(kManifest,CREATE_ALWAYS); NormalizeOwnedSecurity(manifest); WriteAll(manifest,Hex(sealed.pbData,sealed.cbData)); CloseHandle(manifest); LocalFree(sealed.pbData); HANDLE lock=OpenSafe(kLock,OPEN_ALWAYS); NormalizeOwnedSecurity(lock); CloseHandle(lock); std::string store="{\"version\":1,\"generation\":1,\"slots\":["; for(size_t i=0;i<accounts.size();++i){if(i)store+=',';store+="{\"name\":\""+std::string(accounts[i].name.begin(),accounts[i].name.end())+"\",\"sid\":\""+accounts[i].sid+"\",\"state\":\"free\"}";} store+= "],\"crc32\":\""+LeaseCrc(1,sidFacts)+"\"}"; HANDLE file=OpenSafe(kStore,CREATE_ALWAYS); NormalizeOwnedSecurity(file); WriteAll(file,store); CloseHandle(file); }
static void RemoveOwnedState() { HANDLE manifest=CreateFileW(kManifest,DELETE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(manifest!=INVALID_HANDLE_VALUE){BY_HANDLE_FILE_INFORMATION info{}; if(!GetFileInformationByHandle(manifest,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(manifest);throw std::string("PHASE_E_REPARSE_DETECTED");} CloseHandle(manifest); if(!DeleteFileW(kManifest))throw std::string("PHASE_E_MANIFEST_REMOVE_FAILED");} }
static void SetPhaseEPassword(const wchar_t* name) { BYTE random[24]; if(!CryptGenRandom(0,sizeof random,random))throw std::string("PHASE_E_CREDENTIAL_RANDOM_FAILED"); std::wstring password; static const wchar_t alphabet[]=L"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%"; for(auto byte:random)password+=alphabet[byte%(sizeof(alphabet)/sizeof(*alphabet)-1)]; USER_INFO_1003 credential{}; credential.usri1003_password=const_cast<wchar_t*>(password.c_str()); if(NetUserSetInfo(nullptr,name,1003,reinterpret_cast<LPBYTE>(&credential),nullptr)!=NERR_Success)throw std::string("PHASE_E_CREDENTIAL_SET_FAILED"); SecureZeroMemory(&password[0],password.size()*sizeof(wchar_t)); }
// These GUIDs are plugin-owned constants, not names or prefix searches.  The
// last byte selects one exact slot; teardown can therefore never enumerate or
// alter an unrelated FWPM object.
static const GUID kFwpmSublayer = {0x9f1d8d41,0x80c7,0x4d02,{0x8e,0x3a,0x90,0x2f,0x17,0x8b,0x61,0x10}};
static GUID SlotFilterKey(size_t index) { return GUID{0x9f1d8d42,0x80c7,0x4d02,{0x8e,0x3a,0x90,0x2f,0x17,0x8b,0x61,static_cast<unsigned char>(0x11+index)}}; }
static bool SameGuid(const GUID& left,const GUID& right) { return !memcmp(&left,&right,sizeof(GUID)); }
static void VerifyOwnedFilter(const FWPM_FILTER0* filter,const Account& account,size_t index) {
  if(!filter || !SameGuid(filter->filterKey,SlotFilterKey(index)) || !SameGuid(filter->subLayerKey,kFwpmSublayer) ||
     !SameGuid(filter->layerKey,FWPM_LAYER_ALE_AUTH_CONNECT_V4) || filter->action.type!=FWP_ACTION_BLOCK ||
     filter->numFilterConditions!=1 || !SameGuid(filter->filterCondition[0].fieldKey,FWPM_CONDITION_ALE_USER_ID) ||
     filter->filterCondition[0].matchType!=FWP_MATCH_EQUAL || filter->filterCondition[0].conditionValue.type!=FWP_SID ||
     !filter->filterCondition[0].conditionValue.sid)
    throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH");
  PSID sid=nullptr; if(!ConvertStringSidToSidW(account.sid.c_str(),&sid))throw std::string("PHASE_E_SID_RESOLUTION_FAILED");
  bool exact=GetLengthSid(filter->filterCondition[0].conditionValue.sid)==GetLengthSid(sid) && !memcmp(filter->filterCondition[0].conditionValue.sid,sid,GetLengthSid(sid)); LocalFree(sid);
  if(!exact)throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH");
}
static void ReconcileFwpm(const std::vector<Account>& accounts) {
  if(accounts.size()!=8)throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH"); HANDLE engine=nullptr;
  if(FwpmEngineOpen0(nullptr,RPC_C_AUTHN_WINNT,nullptr,nullptr,&engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_OPEN_FAILED");
  try { if(FwpmTransactionBegin0(engine,0)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED");
    FWPM_SUBLAYER0* existing=nullptr; DWORD status=FwpmSubLayerGetByKey0(engine,&kFwpmSublayer,&existing);
    if(status==FWP_E_SUBLAYER_NOT_FOUND) { FWPM_SUBLAYER0 sublayer{}; sublayer.subLayerKey=kFwpmSublayer; sublayer.displayData.name=const_cast<wchar_t*>(L"SRT Phase E owned sublayer"); sublayer.weight=0x8000; if(FwpmSubLayerAdd0(engine,&sublayer,nullptr)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_SUBLAYER_ADD_FAILED"); }
    else { if(status!=ERROR_SUCCESS || !existing || existing->weight!=0x8000)throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH"); FwpmFreeMemory0(reinterpret_cast<void**>(&existing)); }
    for(size_t i=0;i<accounts.size();++i) { GUID key=SlotFilterKey(i); FWPM_FILTER0* found=nullptr; status=FwpmFilterGetByKey0(engine,&key,&found);
      if(status==ERROR_SUCCESS) { VerifyOwnedFilter(found,accounts[i],i); FwpmFreeMemory0(reinterpret_cast<void**>(&found)); continue; }
      if(status!=FWP_E_FILTER_NOT_FOUND)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); PSID sid=nullptr; if(!ConvertStringSidToSidW(accounts[i].sid.c_str(),&sid))throw std::string("PHASE_E_SID_RESOLUTION_FAILED"); FWPM_FILTER_CONDITION0 condition{}; condition.fieldKey=FWPM_CONDITION_ALE_USER_ID; condition.matchType=FWP_MATCH_EQUAL; condition.conditionValue.type=FWP_SID; condition.conditionValue.sid=sid; FWPM_FILTER0 filter{}; filter.filterKey=key; filter.displayData.name=const_cast<wchar_t*>(L"SRT Phase E owned slot filter"); filter.layerKey=FWPM_LAYER_ALE_AUTH_CONNECT_V4; filter.subLayerKey=kFwpmSublayer; filter.numFilterConditions=1; filter.filterCondition=&condition; filter.action.type=FWP_ACTION_BLOCK; filter.weight.type=FWP_UINT8; filter.weight.uint8=0x80; status=FwpmFilterAdd0(engine,&filter,nullptr,nullptr); LocalFree(sid); if(status!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_FILTER_ADD_FAILED"); }
    if(FwpmTransactionCommit0(engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED");
  } catch(...) { FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); throw; } FwpmEngineClose0(engine);
}
static void RemoveOwnedFwpm(const std::vector<Account>& accounts) { HANDLE engine=nullptr; if(FwpmEngineOpen0(nullptr,RPC_C_AUTHN_WINNT,nullptr,nullptr,&engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_OPEN_FAILED"); try { if(FwpmTransactionBegin0(engine,0)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED"); for(size_t i=0;i<accounts.size();++i){GUID key=SlotFilterKey(i); FWPM_FILTER0* found=nullptr; DWORD status=FwpmFilterGetByKey0(engine,&key,&found); if(status==FWP_E_FILTER_NOT_FOUND)continue; if(status!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); VerifyOwnedFilter(found,accounts[i],i); FwpmFreeMemory0(reinterpret_cast<void**>(&found)); if(FwpmFilterDeleteByKey0(engine,&key)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_REMOVE_FAILED");} FWPM_SUBLAYER0* sublayer=nullptr; DWORD status=FwpmSubLayerGetByKey0(engine,&kFwpmSublayer,&sublayer); if(status==ERROR_SUCCESS){if(!sublayer||sublayer->weight!=0x8000)throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH"); FwpmFreeMemory0(reinterpret_cast<void**>(&sublayer)); if(FwpmSubLayerDeleteByKey0(engine,&kFwpmSublayer)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_REMOVE_FAILED");} else if(status!=FWP_E_SUBLAYER_NOT_FOUND)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); if(FwpmTransactionCommit0(engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED"); } catch(...) { FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); throw; } FwpmEngineClose0(engine); }
static void CreatePool() {
  size_t legacy; auto prior=Inspect(&legacy); if(!prior.empty()) throw std::string("PHASE_E_NAMESPACE_AMBIGUOUS"); std::vector<std::wstring> made;
  try { for(auto& name:kPool){ USER_INFO_1 user{}; user.usri1_name=const_cast<wchar_t*>(name); user.usri1_priv=USER_PRIV_USER; user.usri1_flags=UF_SCRIPT|UF_DONT_EXPIRE_PASSWD; DWORD parameter=0; if(NetUserAdd(nullptr,1,reinterpret_cast<LPBYTE>(&user),&parameter)!=NERR_Success) throw std::string("PHASE_E_ACCOUNT_CREATE_FAILED"); made.push_back(name); SetPhaseEPassword(name); } size_t ignored; auto accounts=Inspect(&ignored); if(accounts.size()!=8) throw std::string("PHASE_E_POSTCONDITION_FAILED"); CheckPrerequisites(); ReconcileFwpm(accounts); PersistOwnedState(accounts); }
  catch(...) { for(auto& name:made) NetUserDel(nullptr,name.c_str()); throw; }
}
static std::string Evidence(const char* mode,const char* outcome,const std::vector<Account>& accounts,size_t legacy) {
  std::string list; for(size_t i=0;i<accounts.size();++i){ if(i) list+=','; std::string name(accounts[i].name.begin(),accounts[i].name.end()),sid(accounts[i].sid.begin(),accounts[i].sid.end()); list+="{\"name\":\""+name+"\",\"sid\":\""+sid+"\"}"; }
  return std::string("{\"schema\":\"phase-e-evidence/v1\",\"mode\":\"")+mode+"\",\"outcome\":\""+outcome+"\",\"maintainer\":{\"pid\":"+std::to_string(GetCurrentProcessId())+",\"creationTime\":\"native-process\"},\"canonicalAccounts\":["+list+"],\"legacyAccountCount\":"+std::to_string(legacy)+",\"seclogon\":\"UNKNOWN\",\"manifestGeneration\":0}";
}
static napi_value Run(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) return nullptr;
  char mode[16] = {}; size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], mode, sizeof(mode), &length) != napi_ok) return nullptr;
  const bool valid = !strcmp(mode, "preflight") || !strcmp(mode, "setup") || !strcmp(mode, "repair") || !strcmp(mode, "rollback") || !strcmp(mode, "teardown");
  if (!valid) { napi_throw_error(env, "PHASE_E_INVALID_MODE", "invalid mode"); return nullptr; }
  try { size_t legacy=0; auto accounts=Inspect(&legacy); const char* outcome="PREFLIGHT_OK";
    if(!strcmp(mode,"setup")){ CreatePool(); accounts=Inspect(&legacy); outcome="SETUP_COMPLETE"; }
    else if(!strcmp(mode,"repair")){ if(accounts.empty()) CreatePool(); else { VerifyPersistedOwnership(accounts); CheckPrerequisites(); } accounts=Inspect(&legacy); outcome="REPAIR_COMPLETE"; }
    else if(!strcmp(mode,"rollback")||!strcmp(mode,"teardown")){ if(argc!=2)throw std::string("PHASE_E_MANIFEST_REQUIRED"); size_t manifestLength=0; napi_get_value_string_utf8(env,argv[1],nullptr,0,&manifestLength); std::string manifest(manifestLength+1,0); napi_get_value_string_utf8(env,argv[1],&manifest[0],manifest.size(),&manifestLength); VerifyPersistedOwnership(accounts); if(manifest.find("\"owner\":\"srt-phase-e-maintainer\"")==std::string::npos)throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); for(auto& account:accounts){if(!ContainsAccountFact(manifest,account))throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH");} RemoveOwnedFwpm(accounts); for(auto& account:accounts){if(NetUserDel(nullptr,account.name.c_str())!=NERR_Success)throw std::string("PHASE_E_ROLLBACK_FAILED");} RemoveOwnedState(); accounts.clear(); outcome=!strcmp(mode,"rollback")?"ROLLBACK_COMPLETE":"TEARDOWN_COMPLETE"; }
    std::string result=Evidence(mode,outcome,accounts,legacy); napi_value out; napi_create_string_utf8(env,result.c_str(),result.size(),&out); return out;
  } catch(const std::string& error) { napi_throw_error(env,error.c_str(),error.c_str()); return nullptr; }
}
static napi_value Init(napi_env env, napi_value exports) { napi_value run; napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &run); napi_set_named_property(env, exports, "run", run); return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
