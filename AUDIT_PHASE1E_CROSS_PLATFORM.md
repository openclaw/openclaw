# Phase 1E: Cross-Platform Gap Analysis + Windows Client Recommendation

**Auditor:** System Architecture Designer (Opus 4.6)
**Date:** 2026-02-23
**Scope:** Feature parity across all client platforms, shared code evaluation, Windows client technology recommendation

---

## 1. Platform Architecture Overview

### Web UI (`ui/`)
- **Framework:** Lit 3.x web components + Vite 7.x build
- **Transport:** WebSocket to Gateway
- **Deployment:** Embedded in Gateway (served as static assets)
- **Tabs (14):** Chat, Overview, Channels, Broadcast, Instances, Sessions, Usage, Cron, Agents, Skills, Nodes, Config, Debug, Logs

### macOS App (`apps/macos/`)
- **Framework:** SwiftUI, Swift 6.2, macOS 15+
- **Type:** Menu bar app (MenuBarExtra) with Settings window, Canvas window, and Chat panel
- **Gateway interaction:** Local process management (GatewayProcessManager), IPC (OpenClawIPC), WebSocket (ControlChannel)
- **Auto-update:** Sparkle 2.x
- **CLI companion:** `openclaw-mac` binary
- **Dependencies:** MenuBarExtraAccess, Sparkle, Peekaboo (accessibility bridge), Swabble (voice wake), OpenClawKit (shared)

### iOS App (`apps/ios/`)
- **Framework:** SwiftUI, Swift 6, iOS 18+
- **Type:** Full app with 3 tabs (Screen/Canvas, Voice, Settings)
- **Extensions:** Share Extension (send content to gateway), Watch Extension (watchOS 11+)
- **Gateway connection:** mDNS/Bonjour discovery + manual host, WebSocket
- **Dependencies:** OpenClawKit, OpenClawChatUI, SwabbleKit

### Android App (`apps/android/`)
- **Framework:** Jetpack Compose, Kotlin, Android 12+ (SDK 31)
- **Type:** Full app with Canvas WebView, Chat sheet, Settings sheet
- **Gateway connection:** mDNS/NSD discovery + manual, WebSocket via OkHttp
- **Foreground service:** Persistent notification for background operation
- **Dependencies:** OkHttp, kotlinx-serialization, Compose Material3

### Shared Code (`apps/shared/ActiviKit/`)
- **Package:** OpenClawKit (Swift Package, dual-platform iOS 18 + macOS 15)
- **Products:**
  - `OpenClawProtocol` -- Gateway wire models (GatewayModels, WizardHelpers, AnyCodable)
  - `OpenClawKit` -- Core node logic (GatewayNodeSession, device identity, bridge frames, capabilities, all command types: Camera, Calendar, Contacts, Location, Motion, Photos, Reminders, Screen, Talk, Canvas, Chat, Device, System, Watch)
  - `OpenClawChatUI` -- Shared SwiftUI chat view (ChatView, ChatViewModel, ChatTransport, ChatComposer, ChatMarkdownRenderer, ChatModels, ChatSessions, ChatTheme)
- **External deps:** ElevenLabsKit (TTS), Textual (markdown)
- **Used by:** macOS app, iOS app (not Android -- Android reimplements protocol in Kotlin)

### Swabble Framework (`Swabble/`)
- **Purpose:** On-device voice wake-word detection and speech pipeline
- **Package:** Swift Package, macOS 15 + iOS 17
- **Products:**
  - `Swabble` (SwabbleCore) -- SpeechPipeline, Config, HookExecutor, TranscriptsStore
  - `SwabbleKit` -- WakeWordGate (trigger word matching against SFTranscription segments)
  - `swabble` CLI -- doctor, health, mic, serve, setup, transcribe commands
- **Used by:** macOS app (full Swabble + SwabbleKit), iOS app (SwabbleKit only)
- **Android equivalent:** VoiceWakeManager + VoiceWakeCommandExtractor (reimplemented in Kotlin using Android SpeechRecognizer)

---

## 2. Feature Parity Matrix

| Feature | Web UI | macOS | iOS | Android | Windows |
|---------|--------|-------|-----|---------|---------|
| **Chat** | Full | Full | Full | Full | N/A |
| **Dashboard/Overview** | Full | Partial (menu view, cost usage bar) | None | None | N/A |
| **Channel Management** | Full (Telegram, Slack, Discord, Signal, WhatsApp, iMessage, Nostr, Google Chat) | Full (ChannelsSettings, ChannelConfigForm) | None | None | N/A |
| **Broadcast** | Full | None | None | None | N/A |
| **Instance Management** | Full | Full (InstancesSettings, InstancesStore) | None | None | N/A |
| **Session Management** | Full | Partial (via chat session switcher) | Partial (session switcher in ChatSheet) | Partial (session switcher in ChatSheet) | N/A |
| **Agent Management** | Full (agents panels, tools, skills, status, files) | Partial (AgentWorkspace, AgentEventsWindow) | Partial (agent picker in settings) | None | N/A |
| **Skills Browser** | Full | None | None | None | N/A |
| **Settings/Config** | Full (schema-driven config editor) | Full (GeneralSettings, ConfigSettings, ConfigStore, schema support) | Partial (gateway + device feature toggles) | Partial (gateway + device feature toggles) | N/A |
| **Voice Wake / Wake Word** | None | Full (Swabble SpeechPipeline, configurable triggers, chimes, mic selection, locale) | Full (VoiceWakeManager, SwabbleKit, trigger words) | Full (VoiceWakeManager, SpeechRecognizer, always/foreground modes) | N/A |
| **Talk Mode (Voice Conversation)** | None | Full (TalkModeController, ElevenLabs TTS) | Full (TalkModeManager, TalkOrb, ElevenLabs TTS) | Full (TalkModeManager, TalkOrb, streaming TTS) | N/A |
| **Notifications** | None | Full (UNUserNotificationCenter, time-sensitive, custom sounds) | Partial (remote-notification background mode, push) | Full (foreground service notification, status updates) | N/A |
| **Quick Actions** | Full (overview-quick-actions) | Partial (context menu, hover HUD) | None | None | N/A |
| **Watch / Widgets** | N/A | N/A | Full (WatchExtension: inbox, reply actions, WatchConnectivity) | None | N/A |
| **Share Extension** | N/A | N/A | Full (text, URLs, images to gateway) | None | N/A |
| **Menu Bar / System Tray** | N/A | Full (MenuBarExtra, animated critter icon, left/right click, hover HUD) | N/A | N/A | N/A |
| **Cron Jobs** | Full | Full (CronSettings, CronJobsStore, CronJobEditor) | None | None | N/A |
| **Debug / Diagnostics** | Full (debug view + logs view) | Full (DebugSettings, DebugActions, DiagnosticsFileLog) | Partial (debug canvas status, discovery logs) | Partial (DebugHandler, logcat) | N/A |
| **Logs Viewer** | Full (streaming log tail) | Partial (LogLocator, log tail in settings) | None | None | N/A |
| **Usage Metrics** | Full (cost usage, charts, query, details) | Partial (CostUsageMenuView) | None | None | N/A |
| **Nodes Management** | Full (node list, exec approvals) | Partial (exec approval prompts, device pairing) | None | None | N/A |
| **Canvas (WebView panel)** | N/A (is the canvas) | Full (CanvasWindow, CanvasSchemeHandler, file watcher) | Full (RootCanvas, ScreenTab, ScreenWebView) | Full (WebView canvas in RootScreen) | N/A |
| **Camera Capture** | None | Full (CameraCaptureService) | Full (CameraController) | Full (CameraCaptureManager, CameraHandler) | N/A |
| **Screen Capture** | None | Partial (Peekaboo bridge) | Full (ScreenRecordService, ScreenController) | Full (ScreenRecordManager, ScreenHandler) | N/A |
| **Location Services** | None | None | Full (LocationService, SignificantLocationMonitor, modes: off/whileUsing/always) | Full (LocationCaptureManager, LocationHandler) | N/A |
| **Contacts/Calendar/Reminders** | None | None | Full (ContactsService, CalendarService, RemindersService, EventKit) | None | N/A |
| **Auto-Update** | N/A (gateway-served) | Full (Sparkle 2.x, Developer ID signed) | App Store | Play Store / in-app APK (AppUpdateHandler) | N/A |
| **CLI Install** | N/A | Full (CLIInstaller, CLIInstallPrompter) | N/A | N/A | N/A |
| **Deep Links** | Partial (URL routing) | Full (activi:// URL scheme) | Full (activi:// URL scheme) | Partial | N/A |
| **Onboarding Wizard** | Full (onboarding-wizard) | Full (OnboardingController) | Full (OnboardingWizardView, QRScanner, setup code) | Partial (setup code) | N/A |
| **Gateway Discovery** | N/A (embedded) | Full (Bonjour, Tailscale) | Full (Bonjour/NSD, Tailscale detection, manual) | Full (NSD, manual) | N/A |
| **Auth (Anthropic OAuth)** | None | Full (AnthropicOAuth, AnthropicAuthControls) | None | None | N/A |
| **Exec Approval Prompts** | Full | Full (ExecApprovals UI, gateway prompter) | None | None | N/A |
| **Device Pairing** | None | Full (DevicePairingApprovalPrompter) | Full (via setup code / pair flow) | Full (via setup code) | N/A |

---

## 3. Platform Strengths and Weaknesses

### Web UI
**Strengths:**
- Most complete administrative interface (14 tabs)
- Full channel management, usage analytics, cron, config editing
- Lit + Vite stack produces small, fast bundles
- Schema-driven config form adapts to gateway schema
- Onboarding wizard with skills selection

**Weaknesses:**
- No voice/wake word capability (browser limitation)
- No camera, screen capture, location, or device sensor access
- No system tray / menu bar integration
- No push notifications (only in-page)
- Embedded in gateway, cannot operate standalone

### macOS
**Strengths:**
- Richest native client: menu bar, canvas, chat panel, settings, cron, channels, instances, config
- Voice wake with Swabble (on-device speech pipeline, configurable triggers/chimes)
- Talk mode with ElevenLabs streaming TTS
- Gateway process management (start/stop/attach local gateway)
- Sparkle auto-update, CLI installer, deep links
- Animated status icon with working/idle/sleeping states
- Hover HUD, context menus, exec approval prompts
- Remote connection via SSH tunneling or direct WebSocket
- Peekaboo accessibility bridge for screen inspection

**Weaknesses:**
- macOS 15+ only (excludes older hardware)
- No broadcast view
- No skills browser (only via Web UI)
- No full usage analytics view (just cost bar)
- No full logs streaming view

### iOS
**Strengths:**
- Full node capabilities: camera, screen record, location (always + while using), contacts, calendar, reminders, motion
- Voice wake (SwabbleKit) + Talk mode (ElevenLabs)
- Share extension for sending content from any app
- watchOS companion with inbox + reply actions
- QR scanner for onboarding
- Bonjour + Tailscale gateway discovery
- Deep link support

**Weaknesses:**
- No administrative features (no channels, instances, cron, config editor, agents management, skills browser, usage metrics, logs)
- Positioned as a "node" client, not an admin client
- No broadcast, no overview dashboard
- Background audio mode for voice, but iOS background restrictions apply

### Android
**Strengths:**
- Full node capabilities: camera, screen record, location, SMS reading/sending
- Voice wake with SpeechRecognizer (always-on via foreground service)
- Talk mode with streaming audio (MediaDataSource)
- Canvas WebView renders the embedded gateway UI
- Foreground service with persistent notification
- Material 3 design system
- In-app APK update mechanism

**Weaknesses:**
- No administrative features (same limitation as iOS)
- No contacts, calendar, reminders integration (iOS has these, Android does not)
- No share extension equivalent
- No watch/wearable companion
- Chat UI is reimplemented (not using shared code like iOS/macOS)
- Protocol and models reimplemented in Kotlin (no shared code with Swift platforms)

### Shared Code (OpenClawKit)
**Strengths:**
- Clean separation: Protocol (wire format), Kit (node logic), ChatUI (view layer)
- Used by both macOS and iOS -- significant code reuse
- Covers all command types (camera, calendar, contacts, location, etc.)
- ChatUI shares view model, composer, markdown renderer, theme

**Weaknesses:**
- Swift-only -- Android cannot consume it
- Android must maintain its own parallel implementations of protocol, models, chat UI
- No cross-platform protocol definition (e.g., no protobuf/flatbuffers/shared JSON schema)

---

## 4. Windows Client Technology Evaluation

### Context and Constraints

The Windows client should:
1. Connect to the Gateway via WebSocket (same protocol as all other clients)
2. Provide system tray integration (analogous to macOS menu bar)
3. Support a Canvas WebView panel (like all native clients)
4. Offer Chat, Settings, and ideally some admin features
5. Support voice wake / Talk mode
6. Receive and display notifications
7. Auto-update without requiring an app store

### Technology Comparison

| Criterion | Tauri 2.0 | Electron | .NET MAUI | WinUI 3 |
|-----------|-----------|----------|-----------|---------|
| **Bundle size** | 3-10 MB (uses system WebView2) | 80-150 MB (bundles Chromium) | 20-40 MB (.NET runtime) | 15-30 MB (native) |
| **Native look/feel** | Good (system WebView + native shell via Rust) | Poor (Chrome-like, not native) | Excellent (WinUI controls) | Excellent (native WinUI) |
| **Dev effort (initial)** | Medium (Rust + Web frontend reuse) | Low (Web frontend reuse, familiar tooling) | High (C#/.NET, no code reuse from existing stack) | Very High (C++/C#, no code reuse, Windows-only expertise) |
| **Dev effort (ongoing)** | Low-Medium (Rust plugin model, Tauri CLI) | Medium (dependency churn, security patches for Chromium) | Medium (MAUI evolving, .NET releases) | Medium (Win SDK updates) |
| **WebSocket support** | Full (Rust tokio/tungstenite or JS WebSocket) | Full (native JS WebSocket) | Full (.NET HttpClient/WebSocket) | Full (WinRT WebSocket) |
| **System tray** | Full (built-in, cross-platform API) | Full (via @electron/tray or electron-tray) | Partial (custom implementation needed) | Full (native Windows API) |
| **Auto-update** | Full (tauri-plugin-updater, signed) | Full (electron-updater, Squirrel) | Manual (MSIX or custom) | Manual (MSIX or custom) |
| **Code reuse from Web UI** | High (Lit components render in system WebView2) | Very High (identical Lit components in Chromium) | None (completely different stack) | None (completely different stack) |
| **Voice/audio support** | Good (Web Speech API in WebView2 + Rust native audio via cpal) | Good (Web Speech API + native Node.js addons) | Good (.NET speech recognition APIs) | Excellent (native Windows Speech APIs) |
| **Community/ecosystem** | Growing rapidly (v2 stable, active development) | Massive (mature, extensive plugin ecosystem) | Moderate (Microsoft-backed but declining community enthusiasm) | Small (Windows-only, niche) |
| **Cross-platform potential** | High (same codebase targets Windows + Linux + macOS) | High (same codebase targets all desktop platforms) | Medium (nominally cross-platform but Windows is primary) | None (Windows-only) |
| **Security model** | Strong (Rust backend, sandboxed WebView, capability-based permissions) | Moderate (full Node.js access, larger attack surface) | Strong (.NET sandbox) | Strong (WinRT sandbox) |
| **Memory usage** | Low (30-60 MB typical) | High (150-400 MB due to Chromium) | Moderate (80-120 MB) | Low (40-80 MB) |
| **Startup time** | Fast (< 1 second) | Slow (2-5 seconds cold start) | Moderate (1-2 seconds) | Fast (< 1 second) |

### Weighted Decision Matrix

Weights: Code Reuse (25%), Dev Effort (20%), Bundle Size + Performance (15%), Native Feel (15%), System Tray + Notifications (10%), Auto-Update (10%), Community (5%)

| Criterion (Weight) | Tauri 2.0 | Electron | .NET MAUI | WinUI 3 |
|---------------------|-----------|----------|-----------|---------|
| Code Reuse (25%) | 9/10 | 10/10 | 1/10 | 1/10 |
| Dev Effort (20%) | 7/10 | 9/10 | 4/10 | 3/10 |
| Bundle + Perf (15%) | 9/10 | 3/10 | 6/10 | 8/10 |
| Native Feel (15%) | 7/10 | 4/10 | 9/10 | 10/10 |
| Tray + Notifications (10%) | 9/10 | 8/10 | 5/10 | 9/10 |
| Auto-Update (10%) | 9/10 | 9/10 | 4/10 | 4/10 |
| Community (5%) | 7/10 | 10/10 | 5/10 | 3/10 |
| **Weighted Total** | **8.20** | **7.55** | **4.10** | **4.30** |

---

## 5. Recommendation: Tauri 2.0

### Primary Recommendation: Tauri 2.0

**Rationale:**

1. **Maximum code reuse with the existing Lit/Vite Web UI.** The entire Web UI (Lit web components, 14 tabs, chat, config forms, channels, cron, agents, skills, etc.) can render directly inside Tauri's WebView2 window with zero porting effort. This is the single most important factor -- the Web UI represents thousands of lines of well-tested functionality that would need to be rewritten from scratch with .NET MAUI or WinUI 3.

2. **Minimal bundle size and resource consumption.** Tauri leverages the system-installed WebView2 (standard on Windows 10/11), resulting in a 3-10 MB installer versus Electron's 80-150 MB. The Rust backend process uses 30-60 MB RAM versus Electron's 150-400 MB.

3. **Native system tray is a first-class feature.** Tauri 2.0 has a built-in system tray plugin (`tauri-plugin-tray`) with full support for custom icons, menus, click handlers, and tooltips -- directly analogous to the macOS MenuBarExtra implementation.

4. **Rust backend for system-level features.** Voice wake word detection, audio capture, and notification management can be implemented in the Rust backend layer. The `cpal` crate provides cross-platform audio I/O, and Windows Speech APIs can be called via the `windows` crate. This mirrors the architecture where macOS uses Swift/Swabble for voice wake while the UI renders web content.

5. **Built-in auto-update.** The `tauri-plugin-updater` supports signed updates from a custom server or GitHub Releases, with delta updates and silent background downloads.

6. **Future Linux client for free.** The same Tauri codebase can target Linux (WebKitGTK) with minimal changes, expanding platform reach without additional projects.

7. **Security model aligns with Activi's needs.** Tauri's capability-based permission system (IPC allowlist, scoped filesystem access) provides defense-in-depth for a security-sensitive AI assistant application.

### Architecture Sketch for Tauri Windows Client

```
+------------------------------------------+
|            Tauri Window                  |
|  +------------------------------------+  |
|  |   WebView2 (System)                |  |
|  |   Renders: Lit Web UI              |  |
|  |   - All 14 tabs available          |  |
|  |   - WebSocket to Gateway           |  |
|  |   - Same chat, config, agents...   |  |
|  +------------------------------------+  |
|                                          |
|  Rust Backend (Tauri Core)               |
|  - System tray management               |
|  - Gateway process control (optional)    |
|  - Voice wake (cpal + Windows Speech)    |
|  - Native notifications (windows-rs)     |
|  - Auto-updater                          |
|  - Deep link handler (activi://)         |
|  - Keychain/credential store             |
+------------------------------------------+
     |
     | WebSocket (same protocol)
     v
+------------------------------------------+
|         Gateway (Node.js)                |
+------------------------------------------+
```

### Implementation Phases

**Phase 1 (MVP -- 2-3 weeks):**
- Tauri 2.0 project scaffold with WebView2
- Load existing Web UI in WebView (all 14 tabs functional immediately)
- System tray with status icon + right-click menu
- WebSocket connection status in tray
- Windows installer (NSIS or WiX via Tauri)
- Auto-update via tauri-plugin-updater

**Phase 2 (Native enhancements -- 2-3 weeks):**
- Native Windows notifications (toast notifications via windows-rs)
- Deep link registration (activi:// protocol handler)
- Credential storage in Windows Credential Manager
- Gateway auto-discovery (mDNS via mdns-sd crate)
- Startup with Windows (registry entry or Task Scheduler)

**Phase 3 (Voice + Advanced -- 3-4 weeks):**
- Voice wake word detection (Windows Speech API via windows crate)
- Talk mode (audio capture via cpal, ElevenLabs streaming)
- Local gateway process management (spawn/attach Node.js process)
- Exec approval prompt as native dialog
- Screen capture support (Windows.Graphics.Capture API)

### Why Not Electron?

Electron would provide even easier code reuse (10/10 vs 9/10), but the tradeoffs are significant:

- **150+ MB bundle size** versus 5-10 MB for Tauri
- **150-400 MB RAM usage** -- on a Windows machine that may already be memory-constrained, this is a meaningful burden for a menu-bar-style companion app
- **Slow cold start** (2-5 seconds) versus sub-second for Tauri
- **Security surface** -- full Node.js access in the main process is a broader attack surface than Tauri's sandboxed Rust backend
- **Perception** -- shipping a bundled Chromium for what is primarily a lightweight system tray app feels disproportionate

For a full-featured IDE or creative tool, Electron's tradeoffs are acceptable. For a lightweight, always-running system companion (which is how the macOS app is positioned), Tauri is the architecturally superior choice.

### Why Not .NET MAUI or WinUI 3?

Both options require rewriting the entire UI from scratch, discarding the existing Lit web components. The development cost would be 3-5x higher with no compensating advantage. Neither platform has meaningful community momentum for this type of application, and both would lock the codebase to Windows-only (or Windows-primary) development.

---

## 6. Cross-Platform Code Sharing Gap Analysis

### Current State

```
                     OpenClawKit (Swift)
                    /                    \
               macOS App              iOS App
             (SwiftUI)              (SwiftUI)
                                         \
                                    Watch Extension
                                    Share Extension

              (no shared code)

            Android App (Kotlin)
            (reimplements protocol, chat, models)

            Web UI (Lit/TypeScript)
            (standalone, gateway-embedded)
```

### Key Gaps

1. **No shared protocol definition.** The Gateway wire protocol is defined implicitly through TypeScript types in the Web UI and Swift Codable models in OpenClawKit. Android reimplements everything in Kotlin. A Windows client would need yet another implementation. **Recommendation:** Consider extracting a machine-readable protocol schema (JSON Schema or a lightweight IDL) from the Gateway that can generate type-safe clients for any language.

2. **Android code isolation.** The Android app shares zero code with the Swift platforms. The chat UI, protocol models, gateway session management, and voice wake logic are all independently maintained. This creates a maintenance burden and drift risk.

3. **Web UI is the richest admin surface but cannot access device capabilities.** The mobile and desktop native clients fill device-capability gaps (camera, voice, location) but lack administrative features. This creates a "two-app" mental model for power users.

4. **Voice wake has three independent implementations.** Swabble/SwabbleKit (macOS/iOS), VoiceWakeManager (Android), and the Web UI has none. A Windows client would add a fourth. The core algorithm (WakeWordGate) is simple enough to port, but the speech pipeline integration is platform-specific by nature.

---

## 7. Summary of Findings

| Dimension | Assessment |
|-----------|------------|
| Web UI completeness | Excellent -- full admin surface, 14 tabs, production-quality |
| macOS app maturity | Excellent -- richest native client, voice, canvas, tray, cron, channels, config |
| iOS app maturity | Good -- strong node capabilities, voice, share/watch, but no admin features |
| Android app maturity | Good -- solid node capabilities, voice, canvas, but behind iOS in device integration |
| Shared code effectiveness | Moderate -- Swift code sharing works well, but Android is isolated |
| Protocol portability | Low -- no machine-readable schema, each platform reimplements |
| Windows client gap | Significant -- no Windows client exists, missing an entire platform segment |
| Recommended Windows tech | Tauri 2.0 -- optimal balance of code reuse, performance, native integration |
| Estimated MVP timeline | 2-3 weeks to functional Windows client with all Web UI features |
| Estimated full timeline | 7-10 weeks for voice, notifications, system tray, auto-update parity |

---

*End of Phase 1E Cross-Platform Gap Analysis*
