// Phase E runs in this Node process only: no child process, task, service, COM
// server, or helper is created by this addon.
#ifdef _WIN32
#include <node_api.h>
#include <windows.h>
#include <lm.h>
#include <fwpmu.h>
#include <bcrypt.h>
#include <wincrypt.h>
#include <sddl.h>
#include <aclapi.h>
#include <vector>
#include <set>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <algorithm>
#pragma comment(lib, "netapi32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "bcrypt.lib")

constexpr wchar_t kPool[][10] = {L"srt-w0-01",L"srt-w0-02",L"srt-w0-03",L"srt-w0-04",L"srt-w0-05",L"srt-w0-06",L"srt-w0-07",L"srt-w0-08"};
constexpr wchar_t kRoot[] = L"C:\\ProgramData\\srt-sandbox";
constexpr wchar_t kManifest[] = L"C:\\ProgramData\\srt-sandbox\\phase-e.manifest.dpapi";
constexpr wchar_t kStore[] = L"C:\\ProgramData\\srt-sandbox\\lease-store.json";
constexpr wchar_t kLock[] = L"C:\\ProgramData\\srt-sandbox\\lease-store.lock";
constexpr wchar_t kProfiles[] = L"C:\\ProgramData\\srt-sandbox\\profiles";
constexpr wchar_t kScratch[] = L"C:\\ProgramData\\srt-sandbox\\scratch";
struct Account { std::wstring name, sid; };
class SecureWipe {
 public:
  SecureWipe(void* data, size_t length) : data_(data), length_(length) {}
  ~SecureWipe() { if (data_ && length_) SecureZeroMemory(data_, length_); }
  SecureWipe(const SecureWipe&) = delete;
  SecureWipe& operator=(const SecureWipe&) = delete;
 private:
  void* data_;
  size_t length_;
};
enum class FaultPoint { None, Account, Credential, RootStore, ProfileScratch, Fwpm };
static FaultPoint ParseFault(const char* value) {
  if(!value || !*value) return FaultPoint::None;
  if(!strcmp(value,"fault:account")) return FaultPoint::Account;
  if(!strcmp(value,"fault:credential")) return FaultPoint::Credential;
  if(!strcmp(value,"fault:root-store")) return FaultPoint::RootStore;
  if(!strcmp(value,"fault:profile-scratch")) return FaultPoint::ProfileScratch;
  if(!strcmp(value,"fault:fwpm")) return FaultPoint::Fwpm;
  throw std::string("PHASE_E_INVALID_FAULT_POINT");
}
static void Inject(FaultPoint selected, FaultPoint point) { if(selected==point) throw std::string("PHASE_E_FAULT_INJECTED"); }
static std::string ProcessCreationTime() {
  FILETIME created{}, exited{}, kernel{}, user{};
  if(!GetProcessTimes(GetCurrentProcess(),&created,&exited,&kernel,&user)) throw std::string("PHASE_E_PROCESS_IDENTITY_FAILED");
  ULARGE_INTEGER ticks{}; ticks.LowPart=created.dwLowDateTime; ticks.HighPart=created.dwHighDateTime;
  return std::to_string(ticks.QuadPart);
}
static bool Canonical(const std::wstring& n) { for (auto& p : kPool) if (n == p) return true; return false; }
static std::wstring Sid(PSID sid) { LPWSTR value=nullptr; std::wstring out; if (sid && ConvertSidToStringSidW(sid,&value)) { out=value; LocalFree(value); } return out; }
// Convert the canonical string form produced by ConvertSidToStringSidW without
// consulting a locale or code page. Windows SID text is deliberately ASCII;
// rejecting any other code point keeps JSON facts byte-stable across hosts.
static std::string SidJsonText(const std::wstring& sid) {
  if (sid.empty()) throw std::string("PHASE_E_SID_RESOLUTION_FAILED");
  std::string text;
  text.reserve(sid.size());
  for (wchar_t character : sid) {
    if (character != L'S' && character != L'-' && (character < L'0' || character > L'9'))
      throw std::string("PHASE_E_SID_RESOLUTION_FAILED");
    text.push_back(static_cast<char>(character));
  }
  return text;
}
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
static bool SameAcl(PACL left, PACL right) {
  return left && right && left->AclSize == right->AclSize &&
         !memcmp(left, right, left->AclSize);
}
static void ApplyAndVerifySecurity(HANDLE object, const wchar_t* sddl) {
  PSECURITY_DESCRIPTOR descriptor=nullptr;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(
       sddl, SDDL_REVISION_1, &descriptor, nullptr))
    throw std::string("PHASE_E_ACL_BUILD_FAILED");
  PSID owner=nullptr, group=nullptr; PACL dacl=nullptr, label=nullptr;
  BOOL daclPresent=FALSE, daclDefaulted=FALSE, labelPresent=FALSE, labelDefaulted=FALSE;
  if(!GetSecurityDescriptorOwner(descriptor,&owner,nullptr) || !owner || !IsValidSid(owner) ||
     !GetSecurityDescriptorGroup(descriptor,&group,nullptr) || !group || !IsValidSid(group) ||
     !GetSecurityDescriptorDacl(descriptor,&daclPresent,&dacl,&daclDefaulted) || !daclPresent || !dacl ||
     !GetSecurityDescriptorSacl(descriptor,&labelPresent,&label,&labelDefaulted) || !labelPresent || !label) {
    LocalFree(descriptor); throw std::string("PHASE_E_ACL_BUILD_FAILED");
  }
  DWORD status=SetSecurityInfo(object,SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,
    owner,group,dacl,label);
  if(status!=ERROR_SUCCESS) { LocalFree(descriptor); throw std::string("PHASE_E_ACL_SET_FAILED"); }
  PSECURITY_DESCRIPTOR actual=nullptr; PACL actualDacl=nullptr, actualLabel=nullptr;
  PSID actualOwner=nullptr, actualGroup=nullptr;
  status=GetSecurityInfo(object,SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,
    &actualOwner,&actualGroup,&actualDacl,&actualLabel,&actual);
  SECURITY_DESCRIPTOR_CONTROL control=0; DWORD revision=0;
  bool protectedDacl=actual && GetSecurityDescriptorControl(actual,&control,&revision) && (control&SE_DACL_PROTECTED);
  bool exact=status==ERROR_SUCCESS && actual && actualOwner && actualGroup && actualDacl && actualLabel &&
    IsValidSid(actualOwner) && IsValidSid(actualGroup) && EqualSid(owner,actualOwner) && EqualSid(group,actualGroup) &&
    SameAcl(dacl,actualDacl) && SameAcl(label,actualLabel) && protectedDacl;
  if(actual)LocalFree(actual); LocalFree(descriptor);
  if(!exact) throw std::string("PHASE_E_ACL_VERIFY_FAILED");
}
static void NormalizeOwnedSecurity(HANDLE object) {
  ApplyAndVerifySecurity(object,L"O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)S:(ML;;NW;;;HI)");
}
static std::wstring CurrentUserSid() {
  HANDLE token=nullptr; if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))throw std::string("PHASE_E_TOKEN_QUERY_FAILED");
  DWORD length=0; GetTokenInformation(token,TokenUser,nullptr,0,&length); std::vector<BYTE> buffer(length);
  if(!length||!GetTokenInformation(token,TokenUser,buffer.data(),length,&length)){CloseHandle(token);throw std::string("PHASE_E_TOKEN_QUERY_FAILED");}
  CloseHandle(token); return Sid(reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid);
}
static void NormalizeSlotSecurity(HANDLE object,const std::wstring& sid) {
  std::wstring userSid=CurrentUserSid(); if(userSid.empty())throw std::string("PHASE_E_TOKEN_QUERY_FAILED");
  std::wstring sddl=L"O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;"+sid+L")(A;;0x1200a9;;;"+userSid+L")S:(ML;;NW;;;HI)";
  ApplyAndVerifySecurity(object,sddl.c_str());
}
static HANDLE OpenSafe(const wchar_t* path,DWORD disposition) { HANDLE file=CreateFileW(path,GENERIC_READ|GENERIC_WRITE,0,nullptr,disposition,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(file==INVALID_HANDLE_VALUE) throw std::string("PHASE_E_STORE_OPEN_FAILED"); BY_HANDLE_FILE_INFORMATION info{}; if(!GetFileInformationByHandle(file,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(file);throw std::string("PHASE_E_REPARSE_DETECTED");} return file; }
static bool ExistsSafe(const std::wstring& path,bool directory=false) { HANDLE handle=CreateFileW(path.c_str(),READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr); if(handle==INVALID_HANDLE_VALUE){DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)return false;throw std::string("PHASE_E_ARTIFACT_QUERY_FAILED");} BY_HANDLE_FILE_INFORMATION info{}; bool ok=GetFileInformationByHandle(handle,&info)&&!(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT); CloseHandle(handle); if(!ok)throw std::string("PHASE_E_REPARSE_DETECTED"); return true; }
static bool HasPartialOwnedArtifacts() { if(ExistsSafe(kManifest)||ExistsSafe(kStore)||ExistsSafe(kLock)||ExistsSafe(kProfiles,true)||ExistsSafe(kScratch,true))return true; for(const auto& name:kPool)if(ExistsSafe(std::wstring(kProfiles)+L"\\"+name,true)||ExistsSafe(std::wstring(kScratch)+L"\\"+name,true))return true; return false; }
static void EnsureSafeRoot() { if(!CreateDirectoryW(kRoot,nullptr)&&GetLastError()!=ERROR_ALREADY_EXISTS) throw std::string("PHASE_E_ROOT_CREATE_FAILED"); HANDLE root=CreateFileW(kRoot,READ_CONTROL|WRITE_DAC|WRITE_OWNER,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(root==INVALID_HANDLE_VALUE) throw std::string("PHASE_E_ROOT_OPEN_FAILED"); BY_HANDLE_FILE_INFORMATION info{}; BOOL ok=GetFileInformationByHandle(root,&info); if(!ok||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(root);throw std::string("PHASE_E_REPARSE_DETECTED");} NormalizeOwnedSecurity(root); CloseHandle(root); }
static void EnsureDirectory(const std::wstring& path,const std::wstring* sid=nullptr) { if(!CreateDirectoryW(path.c_str(),nullptr)&&GetLastError()!=ERROR_ALREADY_EXISTS)throw std::string("PHASE_E_PROFILE_CREATE_FAILED"); HANDLE directory=CreateFileW(path.c_str(),READ_CONTROL|WRITE_DAC|WRITE_OWNER,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(directory==INVALID_HANDLE_VALUE)throw std::string("PHASE_E_PROFILE_OPEN_FAILED"); BY_HANDLE_FILE_INFORMATION info{}; BOOL ok=GetFileInformationByHandle(directory,&info); if(!ok||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(directory);throw std::string("PHASE_E_REPARSE_DETECTED");} if(sid)NormalizeSlotSecurity(directory,*sid);else NormalizeOwnedSecurity(directory); CloseHandle(directory); }
static void EnsureProfilesAndScratch(const std::vector<Account>& accounts) { EnsureDirectory(kProfiles); EnsureDirectory(kScratch); for(const auto& account:accounts){std::wstring profile=std::wstring(kProfiles)+L"\\"+account.name; std::wstring scratch=std::wstring(kScratch)+L"\\"+account.name; EnsureDirectory(profile,&account.sid); EnsureDirectory(scratch,&account.sid);} }
static std::string Hex(const BYTE* data,DWORD length) { static const char digits[]="0123456789abcdef"; std::string out; out.reserve(length*2); for(DWORD i=0;i<length;i++){out+=digits[data[i]>>4];out+=digits[data[i]&15];}return out; }
// This deliberately mirrors the small deterministic checksum used by the
// TypeScript policy layer.  It is an integrity tripwire, not a secret-bearing
// MAC: the surrounding DPAPI manifest is the ownership authorization record.
static std::string LeaseCrc(unsigned generation,const std::vector<std::string>& facts) { uint32_t value=0x811c9dc5u; std::string input="phase-e-v1:"+std::to_string(generation)+":"; for(size_t i=0;i<facts.size();++i){if(i)input+=',';input+=facts[i];} for(unsigned char byte:input)value=(value^byte)*0x01000193u; char out[9]={}; sprintf_s(out,sizeof out,"%08x",value); return out; }
static std::vector<BYTE> Unhex(const std::string& value) { if(value.empty() || value.size()%2) throw std::string("PHASE_E_MANIFEST_INVALID"); std::vector<BYTE> bytes; bytes.reserve(value.size()/2); for(size_t i=0;i<value.size();i+=2){ auto nibble=[](char c)->int { if(c>='0'&&c<='9')return c-'0'; if(c>='a'&&c<='f')return c-'a'+10; throw std::string("PHASE_E_MANIFEST_INVALID"); }; bytes.push_back(static_cast<BYTE>((nibble(value[i])<<4)|nibble(value[i+1]))); } return bytes; }
static std::string ReadAll(HANDLE file) { LARGE_INTEGER size{}; if(!GetFileSizeEx(file,&size)||size.QuadPart<=0||size.QuadPart>1024*1024)throw std::string("PHASE_E_MANIFEST_INVALID"); std::string text(static_cast<size_t>(size.QuadPart),0); DWORD read=0; if(!ReadFile(file,&text[0],static_cast<DWORD>(text.size()),&read,nullptr)||read!=text.size())throw std::string("PHASE_E_MANIFEST_READ_FAILED"); return text; }
static bool ContainsAccountFact(const std::string& json,const Account& account) { std::string name(account.name.begin(),account.name.end()); std::string sid=SidJsonText(account.sid); return json.find("\"name\":\""+name+"\"")!=std::string::npos && json.find("\"sid\":\""+sid+"\"")!=std::string::npos; }
// This authorization check deliberately accepts no partial or name-only state.
// The DPAPI blob is opened reparse-safely and is usable only by the maintainer's
// user context; it is not a general-purpose credential or manifest parser.
static void VerifyRecordedMaintainerDead(const std::string& json) { const std::string pidMark="\"pid\":"; const std::string timeMark="\"creationTime\":\""; size_t pidAt=json.find(pidMark),timeAt=json.find(timeMark); if(pidAt==std::string::npos||timeAt==std::string::npos)throw std::string("PHASE_E_PROCESS_IDENTITY_MISMATCH"); unsigned long pid=strtoul(json.c_str()+pidAt+pidMark.size(),nullptr,10); size_t start=timeAt+timeMark.size(),end=json.find('"',start); if(!pid||end==std::string::npos||end==start)throw std::string("PHASE_E_PROCESS_IDENTITY_MISMATCH"); std::string expected=json.substr(start,end-start); HANDLE process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid); if(!process){if(GetLastError()==ERROR_INVALID_PARAMETER)return; throw std::string("PHASE_E_PROCESS_IDENTITY_QUERY_FAILED");} FILETIME created{},exited{},kernel{},user{}; bool ok=GetProcessTimes(process,&created,&exited,&kernel,&user); CloseHandle(process); if(!ok)throw std::string("PHASE_E_PROCESS_IDENTITY_QUERY_FAILED"); ULARGE_INTEGER ticks{};ticks.LowPart=created.dwLowDateTime;ticks.HighPart=created.dwHighDateTime; if(std::to_string(ticks.QuadPart)!=expected)throw std::string("PHASE_E_STALE_PROCESS_IDENTITY"); throw std::string("PHASE_E_MAINTAINER_ACTIVE"); }
static void VerifyPersistedOwnership(const std::vector<Account>& accounts) { HANDLE manifest=OpenSafe(kManifest,OPEN_EXISTING); std::string encoded=ReadAll(manifest); CloseHandle(manifest); auto bytes=Unhex(encoded); DATA_BLOB sealed{static_cast<DWORD>(bytes.size()),bytes.data()},plain{}; if(!CryptUnprotectData(&sealed,nullptr,nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&plain))throw std::string("PHASE_E_MANIFEST_UNSEAL_FAILED"); std::string json(reinterpret_cast<char*>(plain.pbData),plain.cbData); SecureZeroMemory(plain.pbData,plain.cbData); LocalFree(plain.pbData); if(json.find("\"version\":1") == std::string::npos || json.find("\"owner\":\"srt-phase-e-maintainer\"") == std::string::npos || accounts.size()!=8)throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); for(const auto& account:accounts)if(!Canonical(account.name)||!ContainsAccountFact(json,account))throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); VerifyRecordedMaintainerDead(json); }
static void VerifyPersistedStore(const std::vector<Account>& accounts) { HANDLE store=OpenSafe(kStore,OPEN_EXISTING); std::string json=ReadAll(store); CloseHandle(store); if(json.find("\"version\":1")==std::string::npos||json.find("\"generation\":1")==std::string::npos||accounts.size()!=8)throw std::string("PHASE_E_LEASE_STORE_INVALID"); std::vector<std::string> sids; for(const auto& account:accounts){std::string sid=SidJsonText(account.sid);if(json.find("\"name\":\""+std::string(account.name.begin(),account.name.end())+"\",\"sid\":\""+sid+"\",\"state\":\"free\"")==std::string::npos)throw std::string("PHASE_E_LEASE_STORE_INVALID");sids.push_back(sid);} if(json.find("\"crc32\":\""+LeaseCrc(1,sids)+"\"")==std::string::npos)throw std::string("PHASE_E_LEASE_STORE_INVALID"); }
static void PersistOwnedState(const std::vector<Account>& accounts) { EnsureSafeRoot(); std::vector<std::string> accountFacts, sidFacts; for(const auto& account:accounts){std::string name(account.name.begin(),account.name.end()),sid=SidJsonText(account.sid);accountFacts.push_back(name+":"+sid);sidFacts.push_back(sid);} std::sort(accountFacts.begin(),accountFacts.end()); std::string json="{\"version\":1,\"generation\":1,\"owner\":\"srt-phase-e-maintainer\",\"maintainer\":{\"pid\":"+std::to_string(GetCurrentProcessId())+",\"creationTime\":\""+ProcessCreationTime()+"\"},\"invocationId\":\"phase-e-generation-1\",\"createdAccounts\":["; for(size_t i=0;i<accounts.size();i++){if(i)json+=',';json+="{\"name\":\""+std::string(accounts[i].name.begin(),accounts[i].name.end())+"\",\"sid\":\""+SidJsonText(accounts[i].sid)+"\"}";} json+= "],\"crc32\":\""+LeaseCrc(1,accountFacts)+"\"}"; DATA_BLOB plain{static_cast<DWORD>(json.size()),reinterpret_cast<BYTE*>(&json[0])},sealed{}; if(!CryptProtectData(&plain,L"srt-phase-e-manifest",nullptr,nullptr,nullptr,CRYPTPROTECT_UI_FORBIDDEN,&sealed))throw std::string("PHASE_E_DPAPI_SEAL_FAILED"); HANDLE manifest=OpenSafe(kManifest,CREATE_ALWAYS); NormalizeOwnedSecurity(manifest); WriteAll(manifest,Hex(sealed.pbData,sealed.cbData)); CloseHandle(manifest); LocalFree(sealed.pbData); HANDLE lock=OpenSafe(kLock,OPEN_ALWAYS); NormalizeOwnedSecurity(lock); CloseHandle(lock); std::string store="{\"version\":1,\"generation\":1,\"slots\":["; for(size_t i=0;i<accounts.size();++i){if(i)store+=',';store+="{\"name\":\""+std::string(accounts[i].name.begin(),accounts[i].name.end())+"\",\"sid\":\""+SidJsonText(accounts[i].sid)+"\",\"state\":\"free\"}";} store+= "],\"crc32\":\""+LeaseCrc(1,sidFacts)+"\"}"; HANDLE file=OpenSafe(kStore,CREATE_ALWAYS); NormalizeOwnedSecurity(file); WriteAll(file,store); CloseHandle(file); }
static void RemoveOwnedState() { HANDLE manifest=CreateFileW(kManifest,DELETE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(manifest!=INVALID_HANDLE_VALUE){BY_HANDLE_FILE_INFORMATION info{}; if(!GetFileInformationByHandle(manifest,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(manifest);throw std::string("PHASE_E_REPARSE_DETECTED");} CloseHandle(manifest); if(!DeleteFileW(kManifest))throw std::string("PHASE_E_MANIFEST_REMOVE_FAILED");} }
static void SetPhaseEPassword(const wchar_t* name) {
  BYTE random[24]{};
  SecureWipe randomWipe(random, sizeof random);
  if (BCryptGenRandom(nullptr, random, static_cast<ULONG>(sizeof random),
                      BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
    throw std::string("PHASE_E_CREDENTIAL_RANDOM_FAILED");
  std::wstring password;
  static const wchar_t alphabet[] = L"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%";
  for (auto byte : random) password += alphabet[byte % (sizeof(alphabet) / sizeof(*alphabet) - 1)];
  SecureWipe passwordWipe(password.data(), password.size() * sizeof(wchar_t));
  USER_INFO_1003 credential{};
  credential.usri1003_password = password.data();
  if (NetUserSetInfo(nullptr, name, 1003, reinterpret_cast<LPBYTE>(&credential), nullptr) != NERR_Success)
    throw std::string("PHASE_E_CREDENTIAL_SET_FAILED");
}
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
      if(status!=FWP_E_FILTER_NOT_FOUND)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); PSID sid=nullptr; if(!ConvertStringSidToSidW(accounts[i].sid.c_str(),&sid))throw std::string("PHASE_E_SID_RESOLUTION_FAILED"); FWPM_FILTER_CONDITION0 condition{}; condition.fieldKey=FWPM_CONDITION_ALE_USER_ID; condition.matchType=FWP_MATCH_EQUAL; condition.conditionValue.type=FWP_SID; condition.conditionValue.sid=static_cast<SID*>(sid); FWPM_FILTER0 filter{}; filter.filterKey=key; filter.displayData.name=const_cast<wchar_t*>(L"SRT Phase E owned slot filter"); filter.layerKey=FWPM_LAYER_ALE_AUTH_CONNECT_V4; filter.subLayerKey=kFwpmSublayer; filter.numFilterConditions=1; filter.filterCondition=&condition; filter.action.type=FWP_ACTION_BLOCK; filter.weight.type=FWP_UINT8; filter.weight.uint8=0x80; status=FwpmFilterAdd0(engine,&filter,nullptr,nullptr); LocalFree(sid); if(status!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_FILTER_ADD_FAILED"); }
    if(FwpmTransactionCommit0(engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED");
  } catch(...) { FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); throw; } FwpmEngineClose0(engine);
}
static void RemoveOwnedFwpm(const std::vector<Account>& accounts) { HANDLE engine=nullptr; if(FwpmEngineOpen0(nullptr,RPC_C_AUTHN_WINNT,nullptr,nullptr,&engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_OPEN_FAILED"); try { if(FwpmTransactionBegin0(engine,0)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED"); for(size_t i=0;i<accounts.size();++i){GUID key=SlotFilterKey(i); FWPM_FILTER0* found=nullptr; DWORD status=FwpmFilterGetByKey0(engine,&key,&found); if(status==FWP_E_FILTER_NOT_FOUND)continue; if(status!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); VerifyOwnedFilter(found,accounts[i],i); FwpmFreeMemory0(reinterpret_cast<void**>(&found)); if(FwpmFilterDeleteByKey0(engine,&key)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_REMOVE_FAILED");} FWPM_SUBLAYER0* sublayer=nullptr; DWORD status=FwpmSubLayerGetByKey0(engine,&kFwpmSublayer,&sublayer); if(status==ERROR_SUCCESS){if(!sublayer||sublayer->weight!=0x8000)throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH"); FwpmFreeMemory0(reinterpret_cast<void**>(&sublayer)); if(FwpmSubLayerDeleteByKey0(engine,&kFwpmSublayer)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_REMOVE_FAILED");} else if(status!=FWP_E_SUBLAYER_NOT_FOUND)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); if(FwpmTransactionCommit0(engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED"); } catch(...) { FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); throw; } FwpmEngineClose0(engine); }
static void CreatePool(FaultPoint fault) {
  size_t legacy; auto prior=Inspect(&legacy); if(!prior.empty()) throw std::string("PHASE_E_NAMESPACE_AMBIGUOUS"); std::vector<std::wstring> made;
  std::vector<Account> accounts;
  bool rootCreated=false;
  try { for(auto& name:kPool){ USER_INFO_1 user{}; user.usri1_name=const_cast<wchar_t*>(name); user.usri1_priv=USER_PRIV_USER; user.usri1_flags=UF_SCRIPT|UF_DONT_EXPIRE_PASSWD; DWORD parameter=0; if(NetUserAdd(nullptr,1,reinterpret_cast<LPBYTE>(&user),&parameter)!=NERR_Success) throw std::string("PHASE_E_ACCOUNT_CREATE_FAILED"); made.push_back(name); Inject(fault,FaultPoint::Account); SetPhaseEPassword(name); Inject(fault,FaultPoint::Credential); } size_t ignored; accounts=Inspect(&ignored); if(accounts.size()!=8) throw std::string("PHASE_E_POSTCONDITION_FAILED"); CheckPrerequisites(); rootCreated=!ExistsSafe(kRoot,true); EnsureSafeRoot(); Inject(fault,FaultPoint::RootStore); EnsureProfilesAndScratch(accounts); Inject(fault,FaultPoint::ProfileScratch); ReconcileFwpm(accounts); Inject(fault,FaultPoint::Fwpm); PersistOwnedState(accounts); }
  catch(...) { if(!accounts.empty()) { try { RemoveOwnedFwpm(accounts); } catch(...) {} } try { RemoveOwnedState(); } catch(...) {} if(rootCreated)RemoveDirectoryW(kRoot); for(auto& name:made) NetUserDel(nullptr,name.c_str()); throw; }
}
static std::string Evidence(const char* mode,const char* outcome,const std::vector<Account>& accounts,size_t legacy) {
  std::string list; for(size_t i=0;i<accounts.size();++i){ if(i) list+=','; std::string name(accounts[i].name.begin(),accounts[i].name.end()),sid=SidJsonText(accounts[i].sid); list+="{\"name\":\""+name+"\",\"sid\":\""+sid+"\"}"; }
  return std::string("{\"schema\":\"phase-e-evidence/v1\",\"mode\":\"")+mode+"\",\"outcome\":\""+outcome+"\",\"maintainer\":{\"pid\":"+std::to_string(GetCurrentProcessId())+",\"creationTime\":\""+ProcessCreationTime()+"\"},\"canonicalAccounts\":["+list+"],\"legacyAccountCount\":"+std::to_string(legacy)+",\"seclogon\":\"UNKNOWN\",\"manifestGeneration\":0}";
}
static napi_value Run(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) return nullptr;
  char mode[16] = {}; size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], mode, sizeof(mode), &length) != napi_ok) return nullptr;
  const bool valid = !strcmp(mode, "preflight") || !strcmp(mode, "setup") || !strcmp(mode, "repair") || !strcmp(mode, "rollback") || !strcmp(mode, "teardown");
  if (!valid) { napi_throw_error(env, "PHASE_E_INVALID_MODE", "invalid mode"); return nullptr; }
  try { FaultPoint fault=FaultPoint::None; if((!strcmp(mode,"setup")||!strcmp(mode,"repair")) && argc==2) { char faultText[32]={}; size_t faultLength=0; if(napi_get_value_string_utf8(env,argv[1],faultText,sizeof(faultText),&faultLength)!=napi_ok) throw std::string("PHASE_E_INVALID_FAULT_POINT"); fault=ParseFault(faultText); } size_t legacy=0; auto accounts=Inspect(&legacy); const char* outcome="PREFLIGHT_OK";
    if(!strcmp(mode,"setup")){ CreatePool(fault); accounts=Inspect(&legacy); outcome="SETUP_COMPLETE"; }
    else if(!strcmp(mode,"repair")){ if(accounts.empty()) { if(HasPartialOwnedArtifacts())throw std::string("PHASE_E_PARTIAL_STATE_DETECTED"); CreatePool(fault); } else { VerifyPersistedOwnership(accounts); VerifyPersistedStore(accounts); CheckPrerequisites(); EnsureProfilesAndScratch(accounts); ReconcileFwpm(accounts); } accounts=Inspect(&legacy); outcome="REPAIR_COMPLETE"; }
    else if(!strcmp(mode,"rollback")||!strcmp(mode,"teardown")){ if(argc!=2)throw std::string("PHASE_E_MANIFEST_REQUIRED"); size_t manifestLength=0; napi_get_value_string_utf8(env,argv[1],nullptr,0,&manifestLength); std::string manifest(manifestLength+1,0); napi_get_value_string_utf8(env,argv[1],&manifest[0],manifest.size(),&manifestLength); VerifyPersistedOwnership(accounts); VerifyPersistedStore(accounts); if(manifest.find("\"owner\":\"srt-phase-e-maintainer\"")==std::string::npos)throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); for(auto& account:accounts){if(!ContainsAccountFact(manifest,account))throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH");} RemoveOwnedFwpm(accounts); for(auto& account:accounts){if(NetUserDel(nullptr,account.name.c_str())!=NERR_Success)throw std::string("PHASE_E_ROLLBACK_FAILED");} RemoveOwnedState(); accounts.clear(); outcome=!strcmp(mode,"rollback")?"ROLLBACK_COMPLETE":"TEARDOWN_COMPLETE"; }
    std::string result=Evidence(mode,outcome,accounts,legacy); napi_value out; napi_create_string_utf8(env,result.c_str(),result.size(),&out); return out;
  } catch(const std::string& error) { napi_throw_error(env,error.c_str(),error.c_str()); return nullptr; }
}
static napi_value Init(napi_env env, napi_value exports) { napi_value run; napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &run); napi_set_named_property(env, exports, "run", run); return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
