# Ambient Assistant Layer Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first end-to-end Ambient Assistant Layer slice: advanced overlay layout, visible context/status lanes, safe assistant command stubs, richer Thomas states, and gateway/session health visibility.

**Architecture:** Keep all desktop windowing in the existing AppKit overlay controllers, keep the full-screen ambient layer click-through, and expand the existing SwiftUI command dock into a richer assistant surface. Add focused assistant-layer models that are safe and local first; defer true automation execution to later gateway services while still exposing honest proposal/capability/handoff states in the UI.

**Tech Stack:** Swift 6.2, SwiftUI, AppKit `NSPanel`, Swift Testing, existing OpenClaw managers (`GatewayConnection`, `WorkActivityStore`, `CanvasManager`, `WebChatManager`, `DebugActions`, `AppStateStore`).

---

## File Structure

- Create `apps/macos/Sources/OpenClaw/AmbientAssistantLayerModels.swift`
  - Defines assistant context, capabilities, proposal summaries, receipts, visible lane items, tone, and surface snapshot.
- Create `apps/macos/Sources/OpenClaw/AmbientAssistantLayerService.swift`
  - Builds a safe local snapshot from app state, gateway/session status, permissions, and static phase-1 capability data.
- Modify `apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift`
  - Add richer Thomas states and command result tone helpers.
- Modify `apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift`
  - Add advanced assistant commands: `/context`, `/capabilities`, `/receipt`, `/handoff`, `/act`, `/watch`, `/approve`, `/memory`.
- Modify `apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift`
  - Add action environment hooks for assistant snapshots and command stubs that return honest phase-1 states.
- Modify `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`
  - Own the visible `AmbientAssistantSurfaceSnapshot`, refresh it on appear/submit, map command execution to Thomas state, and expose lane data to SwiftUI.
- Modify `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`
  - Implement the advanced layout: top context/status lanes, subagent activity rail, compact proposal/receipt strip, argument hints in suggestions, and dynamic Thomas status.
- Modify `apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
  - Resize/reposition the command dock panel for the richer layout while preserving key focus and click-through outside the panel.
- Test:
  - Add `apps/macos/Tests/OpenClawIPCTests/AmbientAssistantLayerModelTests.swift`
  - Update `apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift`
  - Update `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift`
  - Update `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift`
  - Update `apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift`
  - Update `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift`

---

### Task 1: Assistant Layer Snapshot Models

**Files:**
- Create: `apps/macos/Sources/OpenClaw/AmbientAssistantLayerModels.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientAssistantLayerModelTests.swift`

- [ ] **Step 1: Write the failing model tests**

Create `apps/macos/Tests/OpenClawIPCTests/AmbientAssistantLayerModelTests.swift`:

```swift
import Testing
@testable import OpenClaw

struct AmbientAssistantLayerModelTests {
    @Test func `default snapshot is safe and local`() {
        let snapshot = AmbientAssistantSurfaceSnapshot.default

        #expect(snapshot.context.frontApp == "Current app")
        #expect(snapshot.context.permissionSummaries.contains("Screen: optional"))
        #expect(snapshot.capabilities.contains(where: { $0.id == "gateway.health" && $0.availability == .available }))
        #expect(snapshot.proposals.first?.approvalState == .notRequired)
        #expect(snapshot.receipt.summary == "No recent ambient actions")
    }

    @Test func `tone maps to symbol and color names`() {
        #expect(AmbientAssistantTone.ready.symbolName == "sparkles")
        #expect(AmbientAssistantTone.blocked.symbolName == "exclamationmark.triangle")
        #expect(AmbientAssistantTone.working.statusLabel == "Working")
    }
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientAssistantLayerModelTests
```

Expected: compile failure because `AmbientAssistantSurfaceSnapshot` and related types do not exist.

- [ ] **Step 3: Implement the models**

Create `apps/macos/Sources/OpenClaw/AmbientAssistantLayerModels.swift`:

```swift
import Foundation

enum AmbientAssistantTone: String, CaseIterable, Equatable {
    case ready
    case reading
    case planning
    case waitingForApproval
    case working
    case success
    case blocked
    case error

    var statusLabel: String {
        switch self {
        case .ready: "Ready"
        case .reading: "Reading"
        case .planning: "Planning"
        case .waitingForApproval: "Approval"
        case .working: "Working"
        case .success: "Done"
        case .blocked: "Blocked"
        case .error: "Error"
        }
    }

    var symbolName: String {
        switch self {
        case .ready: "sparkles"
        case .reading: "eye"
        case .planning: "point.topleft.down.curvedto.point.bottomright.up"
        case .waitingForApproval: "checkmark.shield"
        case .working: "gearshape.2"
        case .success: "checkmark.circle"
        case .blocked: "exclamationmark.triangle"
        case .error: "xmark.octagon"
        }
    }
}

enum AmbientAssistantAvailability: String, Equatable {
    case available
    case needsPermission
    case needsApproval
    case unavailable
}

enum AmbientAssistantApprovalState: String, Equatable {
    case notRequired
    case required
    case approved
    case blocked
}

struct AmbientAssistantContextSnapshot: Equatable {
    var frontApp: String
    var sessionLabel: String
    var gatewayLabel: String
    var deviceLabel: String
    var permissionSummaries: [String]
    var confidenceLabel: String
}

struct AmbientAssistantCapability: Equatable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var availability: AmbientAssistantAvailability
}

struct AmbientAssistantProposalSummary: Equatable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var approvalState: AmbientAssistantApprovalState
    var tone: AmbientAssistantTone
}

struct AmbientAssistantReceiptSummary: Equatable {
    var summary: String
    var detail: String
    var tone: AmbientAssistantTone
}

struct AmbientAssistantLaneItem: Equatable, Identifiable {
    var id: String
    var title: String
    var detail: String
    var tone: AmbientAssistantTone
}

struct AmbientAssistantSurfaceSnapshot: Equatable {
    var context: AmbientAssistantContextSnapshot
    var capabilities: [AmbientAssistantCapability]
    var proposals: [AmbientAssistantProposalSummary]
    var receipt: AmbientAssistantReceiptSummary
    var subagents: [AmbientAssistantLaneItem]
    var status: AmbientAssistantLaneItem

    static let `default` = AmbientAssistantSurfaceSnapshot(
        context: AmbientAssistantContextSnapshot(
            frontApp: "Current app",
            sessionLabel: "main session",
            gatewayLabel: "Gateway local",
            deviceLabel: "iPhone handoff not checked",
            permissionSummaries: ["Screen: optional", "Accessibility: optional"],
            confidenceLabel: "Local context"),
        capabilities: [
            AmbientAssistantCapability(
                id: "gateway.health",
                title: "Gateway health",
                detail: "Available through local diagnostics",
                availability: .available),
            AmbientAssistantCapability(
                id: "context.screen",
                title: "Screen context",
                detail: "Requires Screen Recording for visual summaries",
                availability: .needsPermission),
        ],
        proposals: [
            AmbientAssistantProposalSummary(
                id: "phase1.safe",
                title: "Ask or command Thomas",
                detail: "Prompts and local commands are available now",
                approvalState: .notRequired,
                tone: .ready),
        ],
        receipt: AmbientAssistantReceiptSummary(
            summary: "No recent ambient actions",
            detail: "Receipts will appear after approved assistant actions run",
            tone: .ready),
        subagents: [
            AmbientAssistantLaneItem(id: "context", title: "Context Scout", detail: "Ready", tone: .ready),
            AmbientAssistantLaneItem(id: "planner", title: "Intent Planner", detail: "Command-first in phase 1", tone: .planning),
            AmbientAssistantLaneItem(id: "safety", title: "Safety Clerk", detail: "Ask-first for risky work", tone: .waitingForApproval),
        ],
        status: AmbientAssistantLaneItem(id: "status", title: "Thomas", detail: "Ready for a prompt or slash command", tone: .ready))
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
swift test --filter AmbientAssistantLayerModelTests
```

Expected: all `AmbientAssistantLayerModelTests` pass.

---

### Task 2: Snapshot Service And Command Stubs

**Files:**
- Create: `apps/macos/Sources/OpenClaw/AmbientAssistantLayerService.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift`

- [ ] **Step 1: Add failing tests for advanced commands**

Add to `AmbientCommandRegistryTests`:

```swift
@Test func `advanced assistant commands are registered`() {
    let commandNames = AmbientCommandRegistry.default.commands.map(\.name)

    #expect(commandNames.contains("context"))
    #expect(commandNames.contains("capabilities"))
    #expect(commandNames.contains("receipt"))
    #expect(commandNames.contains("handoff"))
    #expect(commandNames.contains("act"))
    #expect(commandNames.contains("watch"))
    #expect(commandNames.contains("approve"))
    #expect(commandNames.contains("memory"))
}
```

Add to `AmbientCommandDockActionTests`:

```swift
@MainActor
@Test func `context command summarizes assistant snapshot`() async {
    let executor = AmbientCommandDockActionExecutor(environment: .testing(
        assistantSnapshot: {
            var snapshot = AmbientAssistantSurfaceSnapshot.default
            snapshot.context.frontApp = "Safari"
            snapshot.context.gatewayLabel = "Gateway healthy"
            return snapshot
        }))

    let result = await executor.execute(name: "context", arguments: "")

    #expect(result == .info("Context: Safari · Gateway healthy · main session"))
}

@MainActor
@Test func `handoff command is honest when iphone service is not wired`() async {
    let executor = AmbientCommandDockActionExecutor(environment: .testing())

    let result = await executor.execute(name: "handoff", arguments: "iphone")

    #expect(result == .info("iPhone handoff is visible in this layer, but execution will be wired in the cross-device phase."))
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --filter AmbientCommandRegistryTests
swift test --filter AmbientCommandDockActionTests
```

Expected: compile failure or assertion failures because advanced commands and `assistantSnapshot` are not wired.

- [ ] **Step 3: Implement service and commands**

Create `AmbientAssistantLayerService.swift`:

```swift
import AppKit
import CoreGraphics
import Foundation

@MainActor
enum AmbientAssistantLayerService {
    static func makeSnapshot() async -> AmbientAssistantSurfaceSnapshot {
        var snapshot = AmbientAssistantSurfaceSnapshot.default
        snapshot.context.sessionLabel = "\(await GatewayConnection.shared.mainSessionKey()) session"
        snapshot.context.gatewayLabel = "Gateway local"
        snapshot.context.frontApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Current app"
        snapshot.context.permissionSummaries = [
            CGPreflightScreenCaptureAccess() ? "Screen: granted" : "Screen: optional",
            AXIsProcessTrusted() ? "Accessibility: granted" : "Accessibility: optional",
        ]
        snapshot.status = AmbientAssistantLaneItem(
            id: "status",
            title: "Thomas",
            detail: WorkActivityStore.shared.current?.label ?? "Ready for a prompt or slash command",
            tone: WorkActivityStore.shared.current == nil ? .ready : .working)
        return snapshot
    }
}
```

Add the new command specs to `AmbientCommandRegistry.default`:

```swift
AmbientCommandSpec(name: "context", aliases: ["ctx"], group: .core, description: "Summarize visible assistant context", argumentHint: nil),
AmbientCommandSpec(name: "capabilities", aliases: ["caps"], group: .core, description: "Show what Thomas can do now", argumentHint: nil),
AmbientCommandSpec(name: "receipt", aliases: ["receipts"], group: .core, description: "Show latest assistant receipt", argumentHint: nil),
AmbientCommandSpec(name: "handoff", aliases: [], group: .automation, description: "Prepare cross-device handoff", argumentHint: "iphone"),
AmbientCommandSpec(name: "act", aliases: [], group: .automation, description: "Create a safe action proposal", argumentHint: nil),
AmbientCommandSpec(name: "watch", aliases: [], group: .automation, description: "Create an opt-in watcher proposal", argumentHint: nil),
AmbientCommandSpec(name: "approve", aliases: [], group: .automation, description: "Approve the selected proposal", argumentHint: nil),
AmbientCommandSpec(name: "memory", aliases: [], group: .automation, description: "Show memory and follow-up status", argumentHint: nil),
```

Extend `AmbientCommandDockActionEnvironment`:

```swift
var assistantSnapshot: @MainActor () async -> AmbientAssistantSurfaceSnapshot
```

Set live to:

```swift
assistantSnapshot: {
    await AmbientAssistantLayerService.makeSnapshot()
}
```

Set testing default to:

```swift
assistantSnapshot: @escaping @MainActor () async -> AmbientAssistantSurfaceSnapshot = { .default }
```

Handle new commands in `AmbientCommandDockActionExecutor.execute`:

```swift
case "context":
    let snapshot = await self.environment.assistantSnapshot()
    return .info("Context: \(snapshot.context.frontApp) · \(snapshot.context.gatewayLabel) · \(snapshot.context.sessionLabel)")
case "capabilities":
    let snapshot = await self.environment.assistantSnapshot()
    let available = snapshot.capabilities.filter { $0.availability == .available }.map(\.title).joined(separator: ", ")
    return .info(available.isEmpty ? "No assistant capabilities are available yet" : "Available: \(available)")
case "receipt":
    let snapshot = await self.environment.assistantSnapshot()
    return .info("\(snapshot.receipt.summary). \(snapshot.receipt.detail)")
case "handoff":
    return .info("iPhone handoff is visible in this layer, but execution will be wired in the cross-device phase.")
case "act":
    return .info("Action proposals are designed; execution will be wired in the proposal service phase.")
case "watch":
    return .info("Watchers are opt-in; proactive watchers will be wired after proposal receipts exist.")
case "approve":
    return .info("No pending ambient proposal is awaiting approval.")
case "memory":
    return .info("Memory curation is planned; current phase keeps memory writes explicit.")
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
swift test --filter AmbientCommandRegistryTests
swift test --filter AmbientCommandDockActionTests
```

Expected: tests pass.

---

### Task 3: Model Integration And Thomas State

**Files:**
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift`

- [ ] **Step 1: Add failing tests for snapshot refresh and richer states**

Add to `AmbientCommandDockModelTests`:

```swift
@MainActor
@Test func `refresh assistant snapshot updates visible context`() async {
    let model = AmbientCommandDockModel(actions: AmbientCommandDockActionExecutor(environment: .testing(
        assistantSnapshot: {
            var snapshot = AmbientAssistantSurfaceSnapshot.default
            snapshot.context.frontApp = "Xcode"
            snapshot.status.detail = "Running tests"
            snapshot.status.tone = .working
            return snapshot
        })))

    await model.refreshAssistantSnapshot()

    #expect(model.assistantSnapshot.context.frontApp == "Xcode")
    #expect(model.assistantSnapshot.status.detail == "Running tests")
    #expect(model.thomasState == .working)
}
```

Add to `AmbientThomasOrbTests`:

```swift
@Test func `new assistant tones map to orb profiles`() {
    let reading = AmbientThomasOrbMotionProfile.profile(for: .reading)
    let approval = AmbientThomasOrbMotionProfile.profile(for: .waitingForApproval)

    #expect(reading.floatAmplitude > 0)
    #expect(approval.glowOpacity > 0)
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
swift test --filter AmbientCommandDockModelTests
swift test --filter AmbientThomasOrbTests
```

Expected: compile failure because the model snapshot and new Thomas states do not exist.

- [ ] **Step 3: Implement model integration**

Extend `AmbientThomasOrbState` with:

```swift
case reading
case planning
case waitingForApproval
case quiet
```

Add profile/color mappings for the new states using calm timing:

```swift
case .reading:
    AmbientThomasOrbMotionProfile(pulseSeconds: 2.2, orbitSeconds: 7.2, floatAmplitude: 9, glowOpacity: 0.34)
case .planning:
    AmbientThomasOrbMotionProfile(pulseSeconds: 2.0, orbitSeconds: 6.2, floatAmplitude: 11, glowOpacity: 0.38)
case .waitingForApproval:
    AmbientThomasOrbMotionProfile(pulseSeconds: 1.6, orbitSeconds: 5.8, floatAmplitude: 6, glowOpacity: 0.46)
case .quiet:
    AmbientThomasOrbMotionProfile(pulseSeconds: 4.0, orbitSeconds: 14.0, floatAmplitude: 3, glowOpacity: 0.16)
```

Add to `AmbientCommandDockModel`:

```swift
private(set) var assistantSnapshot: AmbientAssistantSurfaceSnapshot = .default

func refreshAssistantSnapshot() async {
    self.assistantSnapshot = await self.actions.assistantSnapshot()
    self.sessionLabel = self.assistantSnapshot.context.sessionLabel
    self.thomasState = self.thomasState(for: self.assistantSnapshot.status.tone)
}

private func thomasState(for tone: AmbientAssistantTone) -> AmbientThomasOrbState {
    switch tone {
    case .ready: .ready
    case .reading: .reading
    case .planning: .planning
    case .waitingForApproval: .waitingForApproval
    case .working: .working
    case .success: .success
    case .blocked, .error: .error
    }
}
```

Expose the action executor snapshot:

```swift
@MainActor
func assistantSnapshot() async -> AmbientAssistantSurfaceSnapshot {
    await self.environment.assistantSnapshot()
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
swift test --filter AmbientCommandDockModelTests
swift test --filter AmbientThomasOrbTests
```

Expected: tests pass.

---

### Task 4: Advanced Overlay Layout

**Files:**
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift`

- [ ] **Step 1: Add failing layout tests**

Add to `AmbientOverlayDisplayControllerTests`:

```swift
@Test func `assistant layer frame leaves room for context lanes and orb`() {
    let display = AmbientOverlayDisplayController.DisplaySnapshot(
        id: 1,
        frame: CGRect(x: 0, y: 0, width: 1440, height: 900),
        visibleFrame: CGRect(x: 0, y: 0, width: 1440, height: 860))

    let frame = AmbientOverlayDisplayController.commandDockFrame(for: display)

    #expect(frame.width >= 960)
    #expect(frame.height >= 430)
    #expect(frame.minY == display.visibleFrame.minY + 28)
}
```

Add to `AmbientCommandDockViewSmokeTests`:

```swift
@MainActor
@Test func `advanced assistant command dock view builds body`() {
    let model = AmbientCommandDockModel(registry: .default)
    let view = AmbientCommandDockView(model: model, onDismiss: {})

    _ = view.body
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --filter AmbientOverlayDisplayControllerTests
swift test --filter AmbientCommandDockViewSmokeTests
```

Expected: display frame assertion fails until panel sizing is expanded.

- [ ] **Step 3: Implement advanced layout**

In `AmbientCommandDockView.body`, replace the compact composer-only stack with:

- `AmbientThomasOrbView`
- a main card width of `920`
- `assistantHeader`
- `assistantLanes`
- suggestions list
- result strip
- input row

Add helper views:

```swift
private var assistantLanes: some View { ... }
private func laneItem(_ item: AmbientAssistantLaneItem) -> some View { ... }
private var proposalStrip: some View { ... }
private var receiptStrip: some View { ... }
```

Use existing `.regularMaterial`, 8-12 px corner radii, compact typography, and no nested card stacks beyond individual lane cells.

Update `AmbientCommandSuggestionRow` to show `argumentHint`:

```swift
if let hint = spec.argumentHint {
    Text(hint)
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .foregroundStyle(.tertiary)
}
```

Call `await model.refreshAssistantSnapshot()` from `.task` in `AmbientCommandDockView`.

Update `AmbientOverlayDisplayController.commandDockFrame`:

```swift
let width = min(max(display.visibleFrame.width - 80, 960), 1040)
let height = min(max(display.visibleFrame.height * 0.54, 430), 520)
```

Keep `panel.makeKeyAndOrderFront(nil)` and `NSApp.activate(ignoringOtherApps: true)`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
swift test --filter AmbientOverlayDisplayControllerTests
swift test --filter AmbientCommandDockViewSmokeTests
```

Expected: tests pass.

---

### Task 5: Verification, Build, And Commit

**Files:**
- All files touched in Tasks 1-4.

- [ ] **Step 1: Run the ambient test suite**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter Ambient
```

Expected: all ambient tests pass.

- [ ] **Step 2: Run the full macOS test suite**

Run:

```bash
swift test
```

Expected: full suite passes.

- [ ] **Step 3: Build and relaunch the installed app**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw
./script/build_and_run.sh --verify
```

Expected: `/Applications/OpenClaw.app` is rebuilt, signed, and relaunched with gateway on port `18789`.

- [ ] **Step 4: Commit implementation**

Run:

```bash
git add docs/superpowers/plans/2026-05-16-ambient-assistant-layer-phase-1.md \
  apps/macos/Sources/OpenClaw/AmbientAssistantLayerModels.swift \
  apps/macos/Sources/OpenClaw/AmbientAssistantLayerService.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift \
  apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientAssistantLayerModelTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift
git commit -m "Build ambient assistant layer foundation"
```

Expected: commit succeeds.

---

## Plan Self-Review

- Spec coverage: Phase 1 covers the visible advanced layout, context/status lanes, command stubs, Thomas state, and local-safe capability visibility. Gateway-side capability broker, proposal persistence, execution orchestration, proactive watchers, and iOS execution are explicitly later phases in the approved design.
- Placeholder scan: this plan uses command stubs with exact messages and concrete tests; no task relies on unspecified behavior.
- Type consistency: `AmbientAssistantSurfaceSnapshot`, `AmbientAssistantTone`, `AmbientAssistantLaneItem`, and command names are defined before being used by later tasks.
