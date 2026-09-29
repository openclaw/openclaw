# Phase E Windows ARM64 validation launch

From an elevated interactive console in session 1, invoke the plugin maintainer directly:

`node .\\extensions\\srt-sandbox\\dist\\phase-e-maintainer.js preflight`

Then run `setup`, `repair`, or manifest-owned `teardown` only after review. Do not use a service, scheduled task, PowerShell wrapper, or helper. Native validation must compile `native/phase-e-maintainer.cc` for ARM64 against the installed Node headers and Windows SDK, then record the maintainer PID and creation time in the sanitized manifest. A non-Windows host must stop with `PHASE_E_UNSUPPORTED_PLATFORM` before mutation.

Before executing any mutation mode, run the native compile/link gate from an
ARM64 Visual Studio developer prompt. `NodeRoot` must point to an official
Windows ARM64 Node distribution containing `include\\node` and `node.lib`:

```powershell
.\extensions\srt-sandbox\scripts\verify-windows-arm64-native.ps1 `
  -NodeRoot C:\node-v24.21.0-win-arm64 `
  -OutputDirectory C:\phase-e-build
```

The gate produces `phase_e_maintainer.node` with `cl.exe` and `link.exe` using
`/MACHINE:ARM64`; retain its SHA-256 output with the validation evidence.
