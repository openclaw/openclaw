# iOS App Priorities (OpenClaw / Moltbot)

This report is based on repo code + docs in `/Users/mariano/Coding/openclaw`, with focus on:
- iOS Swift sources under `apps/ios/Sources`
- Shared Swift packages under `apps/shared/OpenClawKit`
- Gateway protocol + node docs in `docs/`
- macOS node implementation under `apps/macos/Sources/OpenClaw/NodeMode`

## Current iOS state (what works today)

**Gateway connectivity + pairing**
- Uses the unified Gateway WebSocket protocol with device identity + challenge signing (via `GatewayChannel` in OpenClawKit).
- Discovery via Bonjour (`NWBrowser`) for `_openclaw-gw._tcp` plus manual host/port fallback and TLS pinning support (`apps/ios/Sources/Gateway/*`).
- Stores gateway token/password in Keychain (`GatewaySettingsStore.swift`).

**Node command handling** (implemented in `NodeAppModel.handleInvoke`)
- Canvas: `canvas.present`, `canvas.hide`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`.
- A2UI: `canvas.a2ui.reset`, `canvas.a2ui.push`, `canvas.a2ui.pushJsonl`.
- Camera: `camera.list`, `camera.snap`, `camera.clip`.
- Screen: `screen.record` (ReplayKit-based screen recording).
- Location: `location.get` (CoreLocation-based).
- Foreground gating: returns `NODE_BACKGROUND_UNAVAILABLE` for canvas/camera/screen when backgrounded.

**Voice features**
- Voice Wake: continuous speech recognition with wake-word gating and gateway sync (`VoiceWakeManager.swift`).
- Talk Mode: speech-to-text + chat.send + ElevenLabs streaming TTS + system voice fallback (`TalkModeManager.swift`).

**Chat UI**
- Uses shared SwiftUI chat client (`OpenClawChatUI`) and Gateway chat APIs (`IOSGatewayChatTransport.swift`).

**UI surface**
- Full-screen canvas with overlay controls for chat, settings, and Talk orb (`RootCanvas.swift`).
- Settings for gateway selection, voice, camera, location, screen prevent-sleep, and debug flags (`SettingsTab.swift`).

## Protocol requirements the iOS app must honor

From `docs/gateway/protocol.md` + `docs/nodes/index.md` + OpenClawKit:
- WebSocket `connect` handshake with `role: "node"`, `caps`, `commands`, and `permissions` claims.
- Device identity + challenge signing on connect; device token persistence.
- Respond to `node.invoke.request` with `node.invoke.result`.
- Emit node events (`node.event`) for voice transcripts and agent requests.
- Use gateway RPCs needed by the iOS UI: `config.get`, `voicewake.get/set`, `chat.*`, `sessions.list`.

## Gaps / incomplete or mismatched behavior

**1) Declared commands exceed iOS implementation**
`GatewayConnectionController.currentCommands()` includes:
- `system.run`, `system.which`, `system.notify`, `system.execApprovals.get`, `system.execApprovals.set`

…but `NodeAppModel.handleInvoke` does not implement any `system.*` commands and will return `INVALID_REQUEST: unknown command` for them. This is a protocol-level mismatch: the gateway will believe iOS supports system execution + notifications, but the node cannot fulfill those requests.

**2) Permissions map is always empty**
iOS sends `permissions: [:]` in its connect options, while macOS node reports real permission states via `PermissionManager`. This means the gateway cannot reason about iOS permission availability even though camera/mic/location/screen limitations materially affect command success.

**3) Canvas parity gaps**
- `canvas.hide` is currently a no-op on iOS (returns ok but doesn’t change UI).
- `canvas.present` ignores placement params (macOS supports window placement).

These may be acceptable platform limitations, but they should be explicitly handled/documented so the node surface is consistent and predictable.

## iOS vs. macOS node feature parity

macOS node mode (`apps/macos/Sources/OpenClaw/NodeMode/*`) supports:
- `system.run`, `system.which`, `system.notify`, `system.execApprovals.get/set`.
- Permission reporting in `connect.permissions`.
- Canvas window placement + hide.

iOS currently implements the shared node surface (canvas/camera/screen/location + voice) but does **not** match macOS on the system/exec side and permission reporting.

## Prioritized work items (ordered by importance)

1) **Fix the command/implementation mismatch for `system.*`**
   - Either remove `system.*` from iOS `currentCommands()` **or** implement iOS equivalents (at minimum `system.notify` via local notifications) with clear error semantics for unsupported actions.
   - This is the highest risk mismatch because it misleads the gateway and any operator about what the iOS node can actually do.

2) **Report real iOS permission state in `connect.permissions`**
   - Mirror macOS behavior by sending camera/microphone/location/screen-recording permission flags.
   - This enables the gateway to make better decisions and reduces “it failed because permissions” surprises.

3) **Clarify/normalize iOS canvas behaviors**
   - Decide how `canvas.hide` should behave on iOS (e.g., return to the local scaffold) and implement it.
   - Document that `canvas.present` ignores placement on iOS, or add a platform-specific best effort.

4) **Explicitly document platform deltas vs. macOS node**
   - The docs currently describe `system.*` under “Nodes” and cite macOS/headless node support. iOS should be clearly marked as not supporting system exec to avoid incorrect user expectations.

5) **Release readiness (if the goal is to move beyond internal preview)**
   - Docs state the iOS app is “internal preview” (`docs/platforms/ios.md`).
   - If public distribution is desired, build out TestFlight/App Store release steps (fastlane exists in `apps/ios/fastlane/`).

## Files referenced (key evidence)

- iOS node behavior: `apps/ios/Sources/Model/NodeAppModel.swift`
- iOS command declarations: `apps/ios/Sources/Gateway/GatewayConnectionController.swift`
- iOS discovery + TLS: `apps/ios/Sources/Gateway/*`
- iOS voice: `apps/ios/Sources/Voice/*`
- iOS screen/camera/location: `apps/ios/Sources/Screen/*`, `apps/ios/Sources/Camera/*`, `apps/ios/Sources/Location/*`
- Shared protocol + commands: `apps/shared/OpenClawKit/Sources/OpenClawKit/*`
- macOS node runtime: `apps/macos/Sources/OpenClaw/NodeMode/*`
- Node + protocol docs: `docs/nodes/index.md`, `docs/gateway/protocol.md`, `docs/platforms/ios.md`
