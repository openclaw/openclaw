# OpenClaw Windows Changelog 🦞📜

## [2026-04-16] - Production Hardening & Monitoring Update

### Added
- **Integrated Monitoring Dashboard**: Added a real-time performance panel to the GUI using `sysinfo` (Rust) and a Cyber-themed frontend.
  - CPU usage tracking with visual progress bars.
  - RSS Memory monitoring.
  - Exact application Uptime calculation.
  - Restart counter from the Watchdog service.
- **Boot Safety**: Added `--allow-unconfigured` flag to gateway launch to ensure first-run success even without a pre-existing config.
- **Recursive Launch Protection**: Added canonical path verification to prevent the wrapper from launching itself as a gateway on Windows.

### Fixed
- **Deadlock Prevention**: Standardized Mutex acquisition order (`process` -> `start_time`) to prevent app freezes during restart cycles.
- **Installer Intelligence**: Updated `install.ps1` to resolve the correct Cargo binary (`openclaw-desktop.exe`) and implemented numerical version comparison for VC++ runtimes.
- **QA Security Leak**: Hardened `package.json` to strictly exclude private `qa-channel` subtrees from npm distribution.
- **Linter & Build**: Fixed floating promises and unused variables in `main.js` to ensure clean `pnpm check` status.
- **Background Refresh**: Implemented a 5-second background state refresh in the watchdog thread for ready-to-use metrics.

### Changed
- Improved the appearance of the GUI with glassmorphism and neon-themed indicator bars.
- Refactored `spawn_gateway` to handle STDOUT/STDERR streams before moving the child process holder.

---
*Created with passion by Aladdin & Antigravity.*
