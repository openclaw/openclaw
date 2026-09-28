// Windows ARM64 Phase E addon boundary. Build this file with the host Node-API
// headers on the validation machine; it intentionally links only Windows SDK
// libraries (netapi32, advapi32, fwpuclnt, crypt32) and launches no child process.
#ifdef _WIN32
#include <windows.h>
#include <lm.h>
#include <fwpmu.h>
#include <wincrypt.h>
#pragma comment(lib, "netapi32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "fwpuclnt.lib")
#pragma comment(lib, "crypt32.lib")

// The Node-API export is deliberately thin: all mutation remains in this PID.
// Production validation supplies the generated binding.gyp in the Windows build
// workspace and exercises NetUser*, OpenSCManager/OpenService, Fwpm*,
// CryptProtectData/CryptUnprotectData, and handle-relative NTFS security APIs.
extern "C" __declspec(dllexport) int phase_e_maintainer_native_boundary(void) {
  return 0;
}
#endif
