# Phase E Windows ARM64 validation launch

From an elevated interactive console in session 1, invoke the plugin maintainer directly:

`node .\\extensions\\srt-sandbox\\dist\\phase-e-maintainer.js preflight`

Then run `setup`, `repair`, or manifest-owned `teardown` only after review. Do not use a service, scheduled task, PowerShell wrapper, or helper. Native validation must compile `native/phase-e-maintainer.cc` for ARM64 against the installed Node headers and Windows SDK, then record the maintainer PID and creation time in the sanitized manifest. A non-Windows host must stop with `PHASE_E_UNSUPPORTED_PLATFORM` before mutation.
