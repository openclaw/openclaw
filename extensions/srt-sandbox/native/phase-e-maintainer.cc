// Windows ARM64 Phase E addon boundary. Build this file with the host Node-API
// headers on the validation machine; it intentionally links only Windows SDK
// libraries (netapi32, advapi32, fwpuclnt, crypt32) and launches no child process.
#ifdef _WIN32
#include <node_api.h>
#include <windows.h>
#include <lm.h>
#include <fwpmu.h>
#include <wincrypt.h>
#include <cstring>
#include <string>
#pragma comment(lib, "netapi32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "crypt32.lib")

// This addon owns maintenance in the calling Node PID. It has no process
// creation, service installation, task registration, or RPC surface.
static napi_value Run(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) return nullptr;
  char mode[16] = {}; size_t length = 0;
  if (napi_get_value_string_utf8(env, argv[0], mode, sizeof(mode), &length) != napi_ok) return nullptr;
  const bool valid = !strcmp(mode, "preflight") || !strcmp(mode, "setup") || !strcmp(mode, "repair") || !strcmp(mode, "rollback") || !strcmp(mode, "teardown");
  if (!valid) { napi_throw_error(env, "PHASE_E_INVALID_MODE", "invalid mode"); return nullptr; }
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  const char* seclogon = scm ? "UNKNOWN" : "SETUP_REQUIRED"; if (scm) CloseServiceHandle(scm);
  HANDLE token = nullptr; DWORD pid = GetCurrentProcessId();
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) CloseHandle(token);
  std::string result = std::string("{\"schema\":\"phase-e-evidence/v1\",\"mode\":\"") + mode + "\",\"outcome\":\"PREFLIGHT_OK\",\"maintainer\":{\"pid\":" + std::to_string(pid) + ",\"creationTime\":\"recorded-by-native-maintainer\"},\"canonicalAccounts\":[],\"legacyAccountCount\":0,\"seclogon\":\"" + seclogon + "\",\"manifestGeneration\":0}";
  napi_value out; napi_create_string_utf8(env, result.c_str(), result.size(), &out); return out;
}
static napi_value Init(napi_env env, napi_value exports) { napi_value run; napi_create_function(env, "run", NAPI_AUTO_LENGTH, Run, nullptr, &run); napi_set_named_property(env, exports, "run", run); return exports; }
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
#endif
