# Known Issues & Limitations

## Open SPIKEs

| ID | Area | Description | Impact |
|----|------|-------------|--------|
| **SPIKE-004** | Voice Wake | Porcupine hotword detection is a stub. The .NET SDK has not been verified on Windows/ARM64. Talk Mode STT (NAudio + WinRT SpeechRecognizer) works — only the "Hey Claude" wake word is missing | No hands-free activation. Voice input via Talk Mode button works |
| **OQ-002** | Canvas eval | `canvas.eval` executes arbitrary JS inside WebView2. Taint flow is documented. WebView2 runs in a separate process with its own sandbox, but there is no additional Chrome Native Messaging-style isolation | Security review recommended before production use |

## Known bugs

None.

## Pending features

| Area | Description |
|------|-------------|
| CLI install prompt | When local mode is active and the openclaw CLI is not found, the app should prompt the user to install it. The gateway process manager logs the error but does not surface a UI prompt yet |

## Limitations vs macOS

| Area | Limitation | Reason |
|------|-----------|--------|
| Channel login/logout | Channels page is read-only (shows status). Cannot login/logout channels from the app | `web.login.start`/`wait`/`channels.logout` RPC not implemented — needs OAuth flow UI |
| Session submenus | Session list in tray shows items but no preview popover or actions (thinking/verbose/reset/compact/delete) | UI complexity — planned for follow-up |
| Tray icon | Static `.ico` per state. No animated critter, badge, or attention dot | Would require custom icon renderer |
| Talk mode | STT + gateway forwarding work. No visual overlay UI, no push-to-talk global hotkey | UI + hotkey registration pending |
| Auto-update | No Sparkle-equivalent. Updates via MSIX reinstall | Inherent to MSIX sideload model |
| `models.list` | Not implemented | Not used in tray or settings — low priority |

## Platform constraints

- **WinUI3 resources need MSIX** — `resources.pri` generation and `ms-appx:///` resource loading require MSIX packaging. The app *can* run unpackaged (`WindowsPackageType=None`, the default in the `.csproj`) for development and testing, but the full resource pipeline (icons, localized strings) only works in MSIX mode
- **WinUI3 has no native tray menu API** — the tray menu is a custom `WindowEx` popup, not a system menu. This requires `SetForegroundWindow` P/Invoke to ensure `Deactivated` fires correctly
- **ARM64 CI** — no native ARM64 Windows runner available in GitHub Actions. ARM64 builds are cross-compiled; tests run only on x64
- **Certificate signing** — MSIX is signed with a self-signed cert (`CN=OpenClaw`). Production signing requires the maintainer's certificate
