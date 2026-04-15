# OpenClaw for Windows 🦞🛡️

The native Windows implementation of the OpenClaw ecosystem, built with Tauri and Rust. This application acts as a robust background service wrapper for the OpenClaw Gateway.

## Key Features

-   **Background Gateway Management**: Silently launches and manages the OpenClaw Gateway process.
-   **Watchdog Protection**: Integrated monitor that automatically restarts the gateway if it crashes (up to 3 attempts with exponential backoff).
-   **System Tray Integration**: Quick access to the Web UI, status monitoring, and graceful application exit.
-   **Self-Elevating Installer**: A hardened PowerShell installer that manages system dependencies (Node.js, VC++ Redistributable, WebView2) and registers the app for autostart.
-   **Persistent Uninstaller**: Automatically registers in Windows "Add/Remove Programs" for a clean lifecycle management.

## Project Structure

-   `src-tauri/`: The core Rust application logic.
    -   `src/main.rs`: Entry point, process management, and Watchdog implementation.
    -   `tauri.conf.json`: Application configuration, sidecar definitions, and system tray settings.
-   `scripts/windows/`: Deployment scripts.
    -   `install.ps1`: The primary installer script.

## Getting Started (Development)

### Prerequisites
- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) (LTS)
- [pnpm](https://pnpm.io/)

### Code Verification
To verify the Rust code without a full build:
```bash
cd src-tauri
cargo check --target x86_64-pc-windows-gnu # Or -msvc on Windows
```

### Building the Application
To generate the production `.msi` or `.exe` installer:
1. Generate icons:
   ```bash
   pnpm run icon:generate
   ```
2. Build the bundle:
   ```bash
   pnpm build
   ```
   The output will be located in `src-tauri/target/release/bundle/`.

## Manual Installation
To install the application using the automated script:
1. Open PowerShell as Administrator.
2. Run:
   ```powershell
   & "scripts/windows/install.ps1"
   ```

## Production Hardening
- **Throttled Notifications**: System notifications for crashes are limited to once every 5 minutes to prevent spam.
- **Resource Embedding**: The gateway is bundled as a Sidecar for standalone operation.
- **Registry Guard**: The uninstaller is persisted in the installation directory to ensure clean removal even if temporary files are lost.

---
Part of the **OpenClaw** core ecosystem.
