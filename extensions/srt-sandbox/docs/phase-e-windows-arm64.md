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

After the native gate, execute the credential-RNG path from the same elevated
interactive session-1 console. It loads the actual ARM64 addon, requires the
credential fault to reach its injected boundary, and verifies that rollback
leaves no canonical account or Phase E root:

```powershell
.\extensions\srt-sandbox\scripts\exercise-windows-arm64-phase-e-rng.ps1 `
  -AddonPath C:\phase-e-build\phase_e_maintainer.node
```

From that same console, execute the retained-handle ACL component gate. It
requires setup to pass application and exact read-back verification of the
SYSTEM owner/group, protected DACL, expected ACEs, and high-integrity label for
the root, profiles/scratch, manifest, stable lock, and lease store. It requires
`SETUP_COMPLETE`, then starts a separate maintainer process for authenticated
manifest-owned teardown and proves canonical=0, root absent, and the foreign
`srt-*` account snapshot unchanged:

```powershell
.\extensions\srt-sandbox\scripts\exercise-windows-arm64-phase-e-acl.ps1 `
  -AddonPath C:\phase-e-build\phase_e_maintainer.node
```
