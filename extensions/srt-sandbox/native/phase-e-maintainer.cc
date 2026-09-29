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
constexpr UINT8 kFwpmFilterWeight = 8;
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
  return left && right && IsValidAcl(left) && IsValidAcl(right) &&
         left->AclSize >= sizeof(ACL) && left->AclSize == right->AclSize &&
         !memcmp(left, right, left->AclSize);
}
static void SecurityStage(const char* object, const char* stage) {
  // stderr is deliberately flushed so an external native crash harness retains
  // the last completed, non-secret boundary even if Node cannot unwind.
  fprintf(stderr, "PHASE_E_SECURITY_STAGE:%s:%s\n", object, stage);
  fflush(stderr);
}
static void SecurityStatus(const char* object, const char* component, DWORD status) {
  fprintf(stderr, "PHASE_E_SECURITY_STATUS:%s:%s:%lu\n", object, component,
          static_cast<unsigned long>(status));
  fflush(stderr);
}
static std::string SecuritySetFailure(const char* component, DWORD status) {
  return std::string("PHASE_E_ACL_SET_FAILED:") + component + ":" +
         std::to_string(static_cast<unsigned long>(status));
}
static bool PrivilegeEnabled(HANDLE token, const LUID& luid) {
  PRIVILEGE_SET privileges{};
  privileges.PrivilegeCount=1;
  privileges.Control=PRIVILEGE_SET_ALL_NECESSARY;
  privileges.Privilege[0].Luid=luid;
  privileges.Privilege[0].Attributes=SE_PRIVILEGE_ENABLED;
  BOOL enabled=FALSE;
  if(!PrivilegeCheck(token,&privileges,&enabled))
    throw std::string("PHASE_E_PRIVILEGE_QUERY_FAILED");
  return enabled==TRUE;
}
class ScopedPrivilege {
 public:
  explicit ScopedPrivilege(const wchar_t* name) {
    if(!OpenProcessToken(GetCurrentProcess(),TOKEN_ADJUST_PRIVILEGES|TOKEN_QUERY,&token_))
      throw std::string("PHASE_E_PRIVILEGE_ENABLE_FAILED");
    if(!LookupPrivilegeValueW(nullptr,name,&luid_)) {
      CloseHandle(token_); token_=nullptr;
      throw std::string("PHASE_E_PRIVILEGE_ENABLE_FAILED");
    }
    try { wasEnabled_=PrivilegeEnabled(token_,luid_); }
    catch(...) { CloseHandle(token_); token_=nullptr; throw; }
    TOKEN_PRIVILEGES requested{};
    requested.PrivilegeCount=1;
    requested.Privileges[0].Luid=luid_;
    requested.Privileges[0].Attributes=SE_PRIVILEGE_ENABLED;
    DWORD previousLength=sizeof(previous_);
    SetLastError(ERROR_SUCCESS);
    if(!AdjustTokenPrivileges(token_,FALSE,&requested,sizeof(previous_),&previous_,&previousLength) ||
       GetLastError()!=ERROR_SUCCESS) {
      CloseHandle(token_); token_=nullptr;
      throw std::string("PHASE_E_PRIVILEGE_ENABLE_FAILED");
    }
    active_=true;
    bool enabled=false;
    try { enabled=PrivilegeEnabled(token_,luid_); }
    catch(...) {
      RestoreNoThrow(); CloseHandle(token_); token_=nullptr;
      throw;
    }
    if(!enabled) {
      RestoreNoThrow(); CloseHandle(token_); token_=nullptr;
      throw std::string("PHASE_E_PRIVILEGE_ENABLE_FAILED");
    }
  }
  ~ScopedPrivilege() { RestoreNoThrow(); if(token_)CloseHandle(token_); }
  ScopedPrivilege(const ScopedPrivilege&)=delete;
  ScopedPrivilege& operator=(const ScopedPrivilege&)=delete;
  void Restore() {
    if(!active_)return;
    if(!AdjustTokenPrivileges(token_,FALSE,&previous_,0,nullptr,nullptr))
      throw std::string("PHASE_E_PRIVILEGE_RESTORE_FAILED");
    if(PrivilegeEnabled(token_,luid_)!=wasEnabled_)
      throw std::string("PHASE_E_PRIVILEGE_RESTORE_FAILED");
    active_=false;
  }
 private:
  void RestoreNoThrow() noexcept {
    if(active_&&token_) {
      AdjustTokenPrivileges(token_,FALSE,&previous_,0,nullptr,nullptr);
      active_=false;
    }
  }
  HANDLE token_=nullptr;
  LUID luid_{};
  TOKEN_PRIVILEGES previous_{};
  bool wasEnabled_=false,active_=false;
};
static void ApplyAndVerifySecurity(HANDLE object, const wchar_t* sddl,
                                   const char* objectName) {
  PSECURITY_DESCRIPTOR descriptor=nullptr;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(
       sddl, SDDL_REVISION_1, &descriptor, nullptr))
    throw std::string("PHASE_E_ACL_BUILD_FAILED");
  PSID owner=nullptr, group=nullptr; PACL dacl=nullptr, label=nullptr;
  BOOL ownerDefaulted=FALSE, groupDefaulted=FALSE, daclPresent=FALSE, daclDefaulted=FALSE,
       labelPresent=FALSE, labelDefaulted=FALSE;
  if(!GetSecurityDescriptorOwner(descriptor,&owner,&ownerDefaulted) || !owner || !IsValidSid(owner) ||
     !GetSecurityDescriptorGroup(descriptor,&group,&groupDefaulted) || !group || !IsValidSid(group) ||
     !GetSecurityDescriptorDacl(descriptor,&daclPresent,&dacl,&daclDefaulted) || !daclPresent || !dacl ||
     !GetSecurityDescriptorSacl(descriptor,&labelPresent,&label,&labelDefaulted) || !labelPresent || !label) {
    LocalFree(descriptor); throw std::string("PHASE_E_ACL_BUILD_FAILED");
  }
  // Do not pass borrowed pointers into a self-relative descriptor to the
  // security APIs.  Keep independently owned, validated buffers alive across
  // both mutation and readback; this also avoids architecture-specific pointer
  // representation/lifetime assumptions at the native ARM64 boundary.
  if(!IsValidAcl(dacl) || dacl->AclSize<sizeof(ACL) ||
     !IsValidAcl(label) || label->AclSize<sizeof(ACL)) {
    LocalFree(descriptor); throw std::string("PHASE_E_ACL_BUILD_FAILED");
  }
  DWORD ownerLength=GetLengthSid(owner),groupLength=GetLengthSid(group);
  // DWORD backing guarantees native alignment for SID/ACL structures on ARM64.
  auto words=[](size_t bytes){return (bytes+sizeof(DWORD)-1)/sizeof(DWORD);};
  std::vector<DWORD> ownerBytes(words(ownerLength)),groupBytes(words(groupLength));
  std::vector<DWORD> daclBytes(words(dacl->AclSize)),labelBytes(words(label->AclSize));
  if(!CopySid(ownerLength,ownerBytes.data(),owner) ||
     !CopySid(groupLength,groupBytes.data(),group)) {
    LocalFree(descriptor); throw std::string("PHASE_E_ACL_BUILD_FAILED");
  }
  memcpy(daclBytes.data(),dacl,dacl->AclSize);
  memcpy(labelBytes.data(),label,label->AclSize);
  LocalFree(descriptor); descriptor=nullptr;
  PSID expectedOwner=reinterpret_cast<PSID>(ownerBytes.data());
  PSID expectedGroup=reinterpret_cast<PSID>(groupBytes.data());
  PACL expectedDacl=reinterpret_cast<PACL>(daclBytes.data());
  PACL expectedLabel=reinterpret_cast<PACL>(labelBytes.data());
  SecurityStage(objectName,"owner-group:before-apply");
  // SeRestorePrivilege is scoped to the owner/group write so SYSTEM remains
  // assignable without broadening the DACL or label operations.
  ScopedPrivilege restorePrivilege(L"SeRestorePrivilege");
  DWORD status=SetSecurityInfo(object,SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION,
    expectedOwner,expectedGroup,nullptr,nullptr);
  SecurityStatus(objectName,"owner-group",status);
  restorePrivilege.Restore();
  if(status!=ERROR_SUCCESS) throw SecuritySetFailure("owner-group",status);
  SecurityStage(objectName,"owner-group:after-apply");
  SecurityStage(objectName,"dacl:before-apply");
  status=SetSecurityInfo(object,SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,
    nullptr,nullptr,expectedDacl,nullptr);
  SecurityStatus(objectName,"dacl",status);
  if(status!=ERROR_SUCCESS) throw SecuritySetFailure("dacl",status);
  SecurityStage(objectName,"dacl:after-apply");
  SecurityStage(objectName,"label:before-apply");
  status=SetSecurityInfo(object,SE_FILE_OBJECT,LABEL_SECURITY_INFORMATION,
    nullptr,nullptr,nullptr,expectedLabel);
  SecurityStatus(objectName,"label",status);
  if(status!=ERROR_SUCCESS) throw SecuritySetFailure("label",status);
  SecurityStage(objectName,"label:after-apply");
  PSECURITY_DESCRIPTOR actual=nullptr; PACL actualDacl=nullptr, actualLabel=nullptr;
  PSID actualOwner=nullptr, actualGroup=nullptr;
  status=GetSecurityInfo(object,SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,
    &actualOwner,&actualGroup,&actualDacl,&actualLabel,&actual);
  SECURITY_DESCRIPTOR_CONTROL control=0; DWORD revision=0;
  bool protectedDacl=actual && GetSecurityDescriptorControl(actual,&control,&revision) && (control&SE_DACL_PROTECTED);
  SecurityStage(objectName,"after-readback");
  bool exact=status==ERROR_SUCCESS && actual && actualOwner && actualGroup && actualDacl && actualLabel &&
    IsValidSid(actualOwner) && IsValidSid(actualGroup) &&
    EqualSid(expectedOwner,actualOwner) && EqualSid(expectedGroup,actualGroup) &&
    SameAcl(expectedDacl,actualDacl) && SameAcl(expectedLabel,actualLabel) && protectedDacl;
  if(actual)LocalFree(actual);
  if(!exact) throw std::string("PHASE_E_ACL_VERIFY_FAILED");
  SecurityStage(objectName,"verified");
}
static void NormalizeOwnedSecurity(HANDLE object) {
  ApplyAndVerifySecurity(object,L"O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)S:(ML;;NW;;;HI)","owned");
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
  ApplyAndVerifySecurity(object,sddl.c_str(),"slot");
}
// Every file returned here is normalized and re-verified through this retained
// handle.  LABEL_SECURITY_INFORMATION uses WRITE_OWNER; owner/group, DACL, and
// the verification read additionally require WRITE_OWNER, WRITE_DAC, and
// READ_CONTROL respectively.
static constexpr DWORD kNormalizedFileAccess=
  GENERIC_READ|GENERIC_WRITE|READ_CONTROL|WRITE_DAC|WRITE_OWNER;
static HANDLE OpenSafe(const wchar_t* path,DWORD disposition) { HANDLE file=CreateFileW(path,kNormalizedFileAccess,0,nullptr,disposition,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); if(file==INVALID_HANDLE_VALUE) throw std::string("PHASE_E_STORE_OPEN_FAILED"); BY_HANDLE_FILE_INFORMATION info{}; if(!GetFileInformationByHandle(file,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(file);throw std::string("PHASE_E_REPARSE_DETECTED");} return file; }
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
static void RemoveOwnedPath(const std::wstring& path,bool directory) {
  HANDLE object=CreateFileW(path.c_str(),DELETE|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|(directory?FILE_FLAG_BACKUP_SEMANTICS:0),nullptr);
  if(object==INVALID_HANDLE_VALUE){DWORD error=GetLastError();if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)return;throw std::string("PHASE_E_OWNED_STATE_REMOVE_FAILED");}
  BY_HANDLE_FILE_INFORMATION info{};
  if(!GetFileInformationByHandle(object,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)){CloseHandle(object);throw std::string("PHASE_E_REPARSE_DETECTED");}
  FILE_DISPOSITION_INFO disposition{TRUE};
  if(!SetFileInformationByHandle(object,FileDispositionInfo,&disposition,sizeof disposition)){CloseHandle(object);throw std::string("PHASE_E_OWNED_STATE_REMOVE_FAILED");}
  CloseHandle(object);
}
static void RemoveOwnedState(const std::vector<Account>& accounts) {
  RemoveOwnedPath(kStore,false); RemoveOwnedPath(kLock,false); RemoveOwnedPath(kManifest,false);
  for(const auto& account:accounts){RemoveOwnedPath(std::wstring(kProfiles)+L"\\"+account.name,true);RemoveOwnedPath(std::wstring(kScratch)+L"\\"+account.name,true);}
  RemoveOwnedPath(kProfiles,true); RemoveOwnedPath(kScratch,true); RemoveOwnedPath(kRoot,true);
}
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
// BFE assigns the closest available sublayer weight rather than guaranteeing
// that the requested value is persisted.  The native gate proved that the
// previously requested 0x8000 is stored as 0x7FFD on the supported host.  Use
// that exact free value for new objects and require the same value on readback,
// preserving fail-closed ownership for the already-created object as well.
constexpr UINT16 kFwpmSublayerWeight = 0x7FFD;
static GUID SlotFilterKey(size_t index) { return GUID{0x9f1d8d42,0x80c7,0x4d02,{0x8e,0x3a,0x90,0x2f,0x17,0x8b,0x61,static_cast<unsigned char>(0x11+index)}}; }
static bool SameGuid(const GUID& left,const GUID& right) { return !memcmp(&left,&right,sizeof(GUID)); }
static void FwpmStage(size_t index,const char* stage) {
  fprintf(stderr,"PHASE_E_FWPM_STAGE:slot:%zu:%s\n",index+1,stage);
  fflush(stderr);
}
static void FwpmStatus(size_t index,const char* operation,DWORD status) {
  fprintf(stderr,"PHASE_E_FWPM_STATUS:slot:%zu:%s:%lu\n",index+1,operation,
          static_cast<unsigned long>(status));
  fflush(stderr);
}
static void RequireFwpmReadback(size_t index,const char* field,bool matches,
                                unsigned long long actual,unsigned long long expected) {
  if(matches)return;
  fprintf(stderr,"PHASE_E_FWPM_READBACK_MISMATCH:slot:%zu:%s:%llu:%llu\n",
          index+1,field,actual,expected);
  fflush(stderr);
  throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH");
}
static void FwpmSublayerStatus(const char* operation,DWORD status) {
  fprintf(stderr,"PHASE_E_FWPM_SUBLAYER_STATUS:%s:%lu\n",operation,
          static_cast<unsigned long>(status));
  fflush(stderr);
}
static void RequireFwpmSublayerReadback(const char* field,bool matches,
                                        unsigned long long actual,unsigned long long expected) {
  if(matches)return;
  fprintf(stderr,"PHASE_E_FWPM_SUBLAYER_READBACK_MISMATCH:%s:%llu:%llu\n",
          field,actual,expected);
  fflush(stderr);
  throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH");
}
static void VerifyOwnedSublayer(const FWPM_SUBLAYER0* sublayer) {
  RequireFwpmSublayerReadback("pointer",sublayer!=nullptr,sublayer?1:0,1);
  RequireFwpmSublayerReadback("key",SameGuid(sublayer->subLayerKey,kFwpmSublayer),0,1);
  RequireFwpmSublayerReadback("weight",sublayer->weight==kFwpmSublayerWeight,
                              sublayer->weight,kFwpmSublayerWeight);
}
static std::string FwpmFilterAddFailure(size_t index,DWORD status) {
  return std::string("PHASE_E_FWPM_FILTER_ADD_FAILED:")+std::to_string(index+1)+":"+
         std::to_string(static_cast<unsigned long>(status));
}
static PSECURITY_DESCRIPTOR UserFilterSecurityDescriptor(PSID sid,ULONG* length) {
  EXPLICIT_ACCESS_W access{};
  access.grfAccessPermissions=FWP_ACTRL_MATCH_FILTER;
  access.grfAccessMode=GRANT_ACCESS;
  access.grfInheritance=NO_INHERITANCE;
  BuildTrusteeWithSidW(&access.Trustee,sid);
  PSECURITY_DESCRIPTOR descriptor=nullptr;
  DWORD status=BuildSecurityDescriptorW(nullptr,nullptr,1,&access,0,nullptr,nullptr,length,&descriptor);
  if(status!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_SECURITY_DESCRIPTOR_FAILED:")+
                                  std::to_string(static_cast<unsigned long>(status));
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision=0;
  if(!IsValidSecurityDescriptor(descriptor) ||
     !GetSecurityDescriptorControl(descriptor,&control,&revision) || !(control&SE_SELF_RELATIVE)) {
    LocalFree(descriptor);
    throw std::string("PHASE_E_FWPM_SECURITY_DESCRIPTOR_INVALID");
  }
  return descriptor;
}
static bool SecurityDescriptorMatchesSid(const FWP_BYTE_BLOB* blob,PSID expected) {
  if(!blob || !blob->data || blob->size<SECURITY_DESCRIPTOR_MIN_LENGTH)return false;
  auto* descriptor=reinterpret_cast<PSECURITY_DESCRIPTOR>(blob->data);
  SECURITY_DESCRIPTOR_CONTROL control{}; DWORD revision=0;
  if(!IsValidSecurityDescriptor(descriptor) || GetSecurityDescriptorLength(descriptor)!=blob->size ||
     !GetSecurityDescriptorControl(descriptor,&control,&revision) || !(control&SE_SELF_RELATIVE))return false;
  BOOL present=FALSE,defaulted=FALSE; PACL dacl=nullptr;
  if(!GetSecurityDescriptorDacl(descriptor,&present,&dacl,&defaulted) || !present || !dacl ||
     !IsValidAcl(dacl) || dacl->AceCount!=1)return false;
  void* rawAce=nullptr;
  if(!GetAce(dacl,0,&rawAce) || !rawAce)return false;
  auto* ace=static_cast<ACCESS_ALLOWED_ACE*>(rawAce);
  PSID actual=&ace->SidStart;
  // BFE persists the condition ACE with READ_CONTROL in addition to the
  // requested match right. Accept only that readback normalization (or the
  // original form), while retaining a single exact-SID allow ACE.
  const DWORD storedMask=FWP_ACTRL_MATCH_FILTER|READ_CONTROL;
  return ace->Header.AceType==ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags==0 &&
         (ace->Mask==FWP_ACTRL_MATCH_FILTER || ace->Mask==storedMask) &&
         IsValidSid(actual) && EqualSid(actual,expected);
}
static void VerifyOwnedFilter(const FWPM_FILTER0* filter,const Account& account,size_t index) {
  RequireFwpmReadback(index,"filter",filter!=nullptr,filter?1:0,1);
  RequireFwpmReadback(index,"filter-key",SameGuid(filter->filterKey,SlotFilterKey(index)),0,1);
  RequireFwpmReadback(index,"layer-key",SameGuid(filter->layerKey,FWPM_LAYER_ALE_AUTH_CONNECT_V4),0,1);
  RequireFwpmReadback(index,"sublayer-key",SameGuid(filter->subLayerKey,kFwpmSublayer),0,1);
  RequireFwpmReadback(index,"action-type",filter->action.type==FWP_ACTION_BLOCK,
                      filter->action.type,FWP_ACTION_BLOCK);
  RequireFwpmReadback(index,"condition-count",filter->numFilterConditions==1,
                      filter->numFilterConditions,1);
  RequireFwpmReadback(index,"condition-array",filter->filterCondition!=nullptr,
                      filter->filterCondition?1:0,1);
  const auto& condition=filter->filterCondition[0];
  RequireFwpmReadback(index,"condition-field",SameGuid(condition.fieldKey,FWPM_CONDITION_ALE_USER_ID),0,1);
  RequireFwpmReadback(index,"condition-match-type",condition.matchType==FWP_MATCH_EQUAL,
                      condition.matchType,FWP_MATCH_EQUAL);
  RequireFwpmReadback(index,"condition-value-type",condition.conditionValue.type==FWP_SECURITY_DESCRIPTOR_TYPE,
                      condition.conditionValue.type,FWP_SECURITY_DESCRIPTOR_TYPE);
  RequireFwpmReadback(index,"security-descriptor-pointer",condition.conditionValue.sd!=nullptr,
                      condition.conditionValue.sd?1:0,1);
  PSID sid=nullptr; if(!ConvertStringSidToSidW(account.sid.c_str(),&sid))throw std::string("PHASE_E_SID_RESOLUTION_FAILED");
  bool exact=SecurityDescriptorMatchesSid(condition.conditionValue.sd,sid); LocalFree(sid);
  RequireFwpmReadback(index,"security-descriptor",exact,exact?1:0,1);
  RequireFwpmReadback(index,"weight-type",filter->weight.type==FWP_UINT8,
                      filter->weight.type,FWP_UINT8);
  RequireFwpmReadback(index,"weight-value",filter->weight.uint8==kFwpmFilterWeight,
                      filter->weight.uint8,kFwpmFilterWeight);
}
static void ReconcileFwpm(const std::vector<Account>& accounts) {
  if(accounts.size()!=8)throw std::string("PHASE_E_FWPM_OWNERSHIP_MISMATCH"); HANDLE engine=nullptr;
  if(FwpmEngineOpen0(nullptr,RPC_C_AUTHN_WINNT,nullptr,nullptr,&engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_OPEN_FAILED");
  try { if(FwpmTransactionBegin0(engine,0)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED");
    FWPM_SUBLAYER0* existing=nullptr; DWORD status=FwpmSubLayerGetByKey0(engine,&kFwpmSublayer,&existing);
    if(status==FWP_E_SUBLAYER_NOT_FOUND) { FWPM_SUBLAYER0 sublayer{}; sublayer.subLayerKey=kFwpmSublayer; sublayer.displayData.name=const_cast<wchar_t*>(L"SRT Phase E owned sublayer"); sublayer.weight=kFwpmSublayerWeight; if(FwpmSubLayerAdd0(engine,&sublayer,nullptr)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_SUBLAYER_ADD_FAILED"); }
    else { if(status!=ERROR_SUCCESS) { FwpmSublayerStatus("query",status); throw std::string("PHASE_E_FWPM_QUERY_FAILED"); } VerifyOwnedSublayer(existing); FwpmFreeMemory0(reinterpret_cast<void**>(&existing)); }
    for(size_t i=0;i<accounts.size();++i) { GUID key=SlotFilterKey(i); FWPM_FILTER0* found=nullptr; status=FwpmFilterGetByKey0(engine,&key,&found);
      if(status==ERROR_SUCCESS) { VerifyOwnedFilter(found,accounts[i],i); FwpmFreeMemory0(reinterpret_cast<void**>(&found)); continue; }
      if(status!=FWP_E_FILTER_NOT_FOUND)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); PSID sid=nullptr; if(!ConvertStringSidToSidW(accounts[i].sid.c_str(),&sid))throw std::string("PHASE_E_SID_RESOLUTION_FAILED"); ULONG descriptorLength=0; PSECURITY_DESCRIPTOR descriptor=nullptr; try { descriptor=UserFilterSecurityDescriptor(sid,&descriptorLength); } catch(...) { LocalFree(sid); throw; } FWP_BYTE_BLOB descriptorBlob{descriptorLength,static_cast<UINT8*>(descriptor)}; FWPM_FILTER_CONDITION0 condition{}; condition.fieldKey=FWPM_CONDITION_ALE_USER_ID; condition.matchType=FWP_MATCH_EQUAL; condition.conditionValue.type=FWP_SECURITY_DESCRIPTOR_TYPE; condition.conditionValue.sd=&descriptorBlob; FWPM_FILTER0 filter{}; filter.filterKey=key; filter.displayData.name=const_cast<wchar_t*>(L"SRT Phase E owned slot filter"); filter.layerKey=FWPM_LAYER_ALE_AUTH_CONNECT_V4; filter.subLayerKey=kFwpmSublayer; filter.numFilterConditions=1; filter.filterCondition=&condition; filter.action.type=FWP_ACTION_BLOCK; filter.weight.type=FWP_UINT8; filter.weight.uint8=kFwpmFilterWeight; FwpmStage(i,"before-filter-add"); status=FwpmFilterAdd0(engine,&filter,nullptr,nullptr); FwpmStatus(i,"filter-add",status); LocalFree(descriptor); LocalFree(sid); if(status!=ERROR_SUCCESS)throw FwpmFilterAddFailure(i,status); FwpmStage(i,"after-filter-add"); }
    if(FwpmTransactionCommit0(engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED");
  } catch(...) { FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); throw; } FwpmEngineClose0(engine);
}
static void RemoveOwnedFwpm(const std::vector<Account>& accounts) { HANDLE engine=nullptr; if(FwpmEngineOpen0(nullptr,RPC_C_AUTHN_WINNT,nullptr,nullptr,&engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_OPEN_FAILED"); try { if(FwpmTransactionBegin0(engine,0)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED"); for(size_t i=0;i<accounts.size();++i){GUID key=SlotFilterKey(i); FWPM_FILTER0* found=nullptr; DWORD status=FwpmFilterGetByKey0(engine,&key,&found); if(status==FWP_E_FILTER_NOT_FOUND)continue; if(status!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_QUERY_FAILED"); VerifyOwnedFilter(found,accounts[i],i); FwpmFreeMemory0(reinterpret_cast<void**>(&found)); if(FwpmFilterDeleteByKey0(engine,&key)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_REMOVE_FAILED");} FWPM_SUBLAYER0* sublayer=nullptr; DWORD status=FwpmSubLayerGetByKey0(engine,&kFwpmSublayer,&sublayer); if(status==ERROR_SUCCESS){VerifyOwnedSublayer(sublayer); FwpmFreeMemory0(reinterpret_cast<void**>(&sublayer)); if(FwpmSubLayerDeleteByKey0(engine,&kFwpmSublayer)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_REMOVE_FAILED");} else if(status!=FWP_E_SUBLAYER_NOT_FOUND){FwpmSublayerStatus("query",status); throw std::string("PHASE_E_FWPM_QUERY_FAILED");} if(FwpmTransactionCommit0(engine)!=ERROR_SUCCESS)throw std::string("PHASE_E_FWPM_TRANSACTION_FAILED"); } catch(...) { FwpmTransactionAbort0(engine); FwpmEngineClose0(engine); throw; } FwpmEngineClose0(engine); }
static void CreatePool(FaultPoint fault) {
  size_t legacy; auto prior=Inspect(&legacy); if(!prior.empty()) throw std::string("PHASE_E_NAMESPACE_AMBIGUOUS"); std::vector<std::wstring> made;
  std::vector<Account> accounts;
  bool rootCreated=false;
  try { for(auto& name:kPool){ USER_INFO_1 user{}; user.usri1_name=const_cast<wchar_t*>(name); user.usri1_priv=USER_PRIV_USER; user.usri1_flags=UF_SCRIPT|UF_DONT_EXPIRE_PASSWD; DWORD parameter=0; if(NetUserAdd(nullptr,1,reinterpret_cast<LPBYTE>(&user),&parameter)!=NERR_Success) throw std::string("PHASE_E_ACCOUNT_CREATE_FAILED"); made.push_back(name); Inject(fault,FaultPoint::Account); SetPhaseEPassword(name); Inject(fault,FaultPoint::Credential); } size_t ignored; accounts=Inspect(&ignored); if(accounts.size()!=8) throw std::string("PHASE_E_POSTCONDITION_FAILED"); CheckPrerequisites(); rootCreated=!ExistsSafe(kRoot,true); EnsureSafeRoot(); Inject(fault,FaultPoint::RootStore); EnsureProfilesAndScratch(accounts); Inject(fault,FaultPoint::ProfileScratch); ReconcileFwpm(accounts); Inject(fault,FaultPoint::Fwpm); PersistOwnedState(accounts); }
  catch(...) { if(!accounts.empty()) { try { RemoveOwnedFwpm(accounts); } catch(...) {} try { RemoveOwnedState(accounts); } catch(...) {} } if(rootCreated)RemoveDirectoryW(kRoot); for(auto& name:made) NetUserDel(nullptr,name.c_str()); throw; }
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
    else if(!strcmp(mode,"rollback")||!strcmp(mode,"teardown")){ if(argc!=2)throw std::string("PHASE_E_MANIFEST_REQUIRED"); size_t manifestLength=0; napi_get_value_string_utf8(env,argv[1],nullptr,0,&manifestLength); std::string manifest(manifestLength+1,0); napi_get_value_string_utf8(env,argv[1],&manifest[0],manifest.size(),&manifestLength); VerifyPersistedOwnership(accounts); VerifyPersistedStore(accounts); if(manifest.find("\"owner\":\"srt-phase-e-maintainer\"")==std::string::npos)throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH"); for(auto& account:accounts){if(!ContainsAccountFact(manifest,account))throw std::string("PHASE_E_MANIFEST_OWNERSHIP_MISMATCH");} RemoveOwnedFwpm(accounts); for(auto& account:accounts){if(NetUserDel(nullptr,account.name.c_str())!=NERR_Success)throw std::string("PHASE_E_ROLLBACK_FAILED");} RemoveOwnedState(accounts); accounts.clear(); outcome=!strcmp(mode,"rollback")?"ROLLBACK_COMPLETE":"TEARDOWN_COMPLETE"; }
    std::string result=Evidence(mode,outcome,accounts,legacy); napi_value out; napi_create_string_utf8(env,result.c_str(),result.size(),&out); return out;
  } catch(const std::string& error) { napi_throw_error(env,error.c_str(),error.c_str()); return nullptr; }
}
static napi_value Init(napi_env env, napi_value exports) { napi_value run; napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &run); napi_set_named_property(env, exports, "run", run); return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
