# Ambient Command Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the macOS Ambient Overlay into a rich bottom chat composer with slash commands and a Canvas-like floating Thomas orb.

**Architecture:** Keep the existing ambient fullscreen panels click-through and replace the minimal workspace sheet with a focused composer panel. Put parser/model/action logic in dedicated testable files, keep AppKit panel management in `AmbientOverlayDisplayController`, and keep gateway/local actions behind a small command executor. Thomas orb is a standalone SwiftUI component inside the composer panel for v1.

**Tech Stack:** Swift 6.2, SwiftUI, AppKit `NSPanel`, Swift Testing, existing OpenClaw managers (`GatewayConnection`, `CanvasManager`, `WebChatManager`, `DebugActions`, `SettingsWindowOpener`, `WorkActivityStore`).

---

## File Structure

- Create `apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift`
  - Defines command groups, command specs, parsed input, command results, Thomas orb states, and style/motion profiles.
- Create `apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift`
  - Defines the supported slash-command registry, parser, suggestions, and argument validation.
- Create `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`
  - Observable composer model: input, suggestions, selected suggestion, result text, sending state, orb state, submit handling.
- Create `apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift`
  - Executes local commands and sends plain text prompts through existing gateway paths.
- Create `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`
  - SwiftUI composer, suggestions list, inline result strip, and floating Thomas orb view.
- Modify `apps/macos/Sources/OpenClaw/AmbientOverlayViews.swift`
  - Keep ambient background only; remove or supersede the minimal `AmbientWorkspaceSheetView`.
- Modify `apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
  - Host `AmbientCommandDockView` in the interactive panel, size it for the orb + composer, and keep the panel above ambient decoration.
- Modify `apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`
  - Rename workspace semantics internally to command dock where practical, wire composer dismissal, preserve escape/hotkey behavior.
- Add tests:
  - `apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift`
  - `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift`
  - `apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift`
  - Update existing ambient display/view smoke tests.

---

### Task 1: Command Types And Parser

**Files:**
- Create: `apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift`
- Create: `apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift`

- [ ] **Step 1: Write failing parser tests**

Create `apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift`:

```swift
import Testing
@testable import OpenClaw

struct AmbientCommandRegistryTests {
    @Test func `plain text parses as prompt`() {
        let parsed = AmbientCommandRegistry.default.parse("Summarize my latest messages")

        #expect(parsed == .prompt("Summarize my latest messages"))
    }

    @Test func `known slash command parses with arguments`() {
        let parsed = AmbientCommandRegistry.default.parse("/intensity 70")

        #expect(parsed == .command(name: "intensity", arguments: "70"))
    }

    @Test func `unknown slash command reports closest suggestions`() {
        let parsed = AmbientCommandRegistry.default.parse("/rest")

        guard case let .unknown(name, suggestions) = parsed else {
            Issue.record("Expected unknown command")
            return
        }

        #expect(name == "rest")
        #expect(suggestions.map(\.name).contains("restart-gateway"))
        #expect(suggestions.map(\.name).contains("reset-tunnel"))
    }

    @Test func `suggestions filter by prefix and include help text`() {
        let suggestions = AmbientCommandRegistry.default.suggestions(for: "/ca")

        #expect(suggestions.map(\.name) == ["camera", "canvas"])
        #expect(suggestions.first?.group == .modes)
        #expect(suggestions.last?.group == .surfaces)
        #expect(suggestions.last?.description == "Open or close Canvas")
    }

    @Test func `empty slash returns grouped suggestions`() {
        let suggestions = AmbientCommandRegistry.default.suggestions(for: "/")

        #expect(suggestions.contains(where: { $0.name == "help" }))
        #expect(suggestions.contains(where: { $0.name == "canvas" }))
        #expect(suggestions.contains(where: { $0.name == "restart-gateway" }))
    }
}
```

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandRegistryTests
```

Expected: compile failure because `AmbientCommandRegistry` and related types do not exist.

- [ ] **Step 3: Implement command types and registry**

Create `apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift`:

```swift
import Foundation

enum AmbientCommandGroup: String, CaseIterable, Equatable {
    case core
    case surfaces
    case voice
    case gateway
    case sessions
    case modes
    case automation

    var title: String {
        switch self {
        case .core: "Core"
        case .surfaces: "Surfaces"
        case .voice: "Voice"
        case .gateway: "Gateway"
        case .sessions: "Sessions"
        case .modes: "Modes"
        case .automation: "Automation"
        }
    }
}

struct AmbientCommandSpec: Equatable, Identifiable {
    var name: String
    var aliases: [String]
    var group: AmbientCommandGroup
    var description: String
    var argumentHint: String?

    var id: String { self.name }
    var displayName: String { "/\(self.name)" }
}

enum AmbientParsedInput: Equatable {
    case empty
    case prompt(String)
    case command(name: String, arguments: String)
    case unknown(name: String, suggestions: [AmbientCommandSpec])
}

enum AmbientCommandResult: Equatable {
    case none
    case success(String)
    case failure(String)
    case info(String)
}

enum AmbientThomasOrbState: Equatable {
    case ready
    case focused
    case sending
    case working
    case success
    case error
}

struct AmbientThomasOrbMotionProfile: Equatable {
    var pulseSeconds: Double
    var orbitSeconds: Double
    var floatAmplitude: Double
    var glowOpacity: Double

    static func profile(for state: AmbientThomasOrbState) -> AmbientThomasOrbMotionProfile {
        switch state {
        case .ready:
            AmbientThomasOrbMotionProfile(pulseSeconds: 2.8, orbitSeconds: 10.0, floatAmplitude: 10, glowOpacity: 0.28)
        case .focused:
            AmbientThomasOrbMotionProfile(pulseSeconds: 2.4, orbitSeconds: 8.0, floatAmplitude: 12, glowOpacity: 0.36)
        case .sending:
            AmbientThomasOrbMotionProfile(pulseSeconds: 1.25, orbitSeconds: 3.6, floatAmplitude: 7, glowOpacity: 0.48)
        case .working:
            AmbientThomasOrbMotionProfile(pulseSeconds: 1.8, orbitSeconds: 5.0, floatAmplitude: 14, glowOpacity: 0.42)
        case .success:
            AmbientThomasOrbMotionProfile(pulseSeconds: 1.0, orbitSeconds: 6.0, floatAmplitude: 10, glowOpacity: 0.52)
        case .error:
            AmbientThomasOrbMotionProfile(pulseSeconds: 3.2, orbitSeconds: 12.0, floatAmplitude: 4, glowOpacity: 0.34)
        }
    }
}
```

Create `apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift`:

```swift
import Foundation

struct AmbientCommandRegistry {
    static let `default` = AmbientCommandRegistry(commands: [
        AmbientCommandSpec(name: "help", aliases: ["?"], group: .core, description: "Show available commands", argumentHint: nil),
        AmbientCommandSpec(name: "clear", aliases: [], group: .core, description: "Clear the composer result", argumentHint: nil),
        AmbientCommandSpec(name: "dismiss", aliases: ["close"], group: .core, description: "Dismiss Ambient Overlay", argumentHint: nil),
        AmbientCommandSpec(name: "status", aliases: [], group: .core, description: "Show gateway and session status", argumentHint: nil),
        AmbientCommandSpec(name: "canvas", aliases: [], group: .surfaces, description: "Open or close Canvas", argumentHint: nil),
        AmbientCommandSpec(name: "chat", aliases: ["webui"], group: .surfaces, description: "Open Chat", argumentHint: nil),
        AmbientCommandSpec(name: "dashboard", aliases: [], group: .surfaces, description: "Open Dashboard", argumentHint: nil),
        AmbientCommandSpec(name: "settings", aliases: ["prefs"], group: .surfaces, description: "Open Settings", argumentHint: nil),
        AmbientCommandSpec(name: "agent-events", aliases: ["events"], group: .surfaces, description: "Open Agent Events", argumentHint: nil),
        AmbientCommandSpec(name: "talk", aliases: [], group: .voice, description: "Toggle Talk Mode", argumentHint: nil),
        AmbientCommandSpec(name: "voice-wake", aliases: ["wake"], group: .voice, description: "Toggle Voice Wake", argumentHint: nil),
        AmbientCommandSpec(name: "mic", aliases: [], group: .voice, description: "Open microphone settings", argumentHint: nil),
        AmbientCommandSpec(name: "health", aliases: [], group: .gateway, description: "Run a health check", argumentHint: nil),
        AmbientCommandSpec(name: "restart-gateway", aliases: ["restart"], group: .gateway, description: "Restart the gateway", argumentHint: nil),
        AmbientCommandSpec(name: "reset-tunnel", aliases: ["tunnel"], group: .gateway, description: "Reset the remote tunnel", argumentHint: nil),
        AmbientCommandSpec(name: "logs", aliases: ["log"], group: .gateway, description: "Open current log file", argumentHint: nil),
        AmbientCommandSpec(name: "config", aliases: [], group: .gateway, description: "Open config folder", argumentHint: nil),
        AmbientCommandSpec(name: "session-store", aliases: ["store"], group: .gateway, description: "Open session store", argumentHint: nil),
        AmbientCommandSpec(name: "sessions", aliases: [], group: .sessions, description: "Open session settings", argumentHint: nil),
        AmbientCommandSpec(name: "main", aliases: [], group: .sessions, description: "Use the main session", argumentHint: nil),
        AmbientCommandSpec(name: "new", aliases: [], group: .sessions, description: "Open Chat for a new session", argumentHint: nil),
        AmbientCommandSpec(name: "compact", aliases: [], group: .sessions, description: "Compact the active session", argumentHint: nil),
        AmbientCommandSpec(name: "reset-session", aliases: [], group: .sessions, description: "Reset the active session", argumentHint: nil),
        AmbientCommandSpec(name: "approvals", aliases: [], group: .modes, description: "Open approval settings", argumentHint: nil),
        AmbientCommandSpec(name: "browser", aliases: [], group: .modes, description: "Toggle browser control", argumentHint: nil),
        AmbientCommandSpec(name: "camera", aliases: [], group: .modes, description: "Toggle camera access", argumentHint: nil),
        AmbientCommandSpec(name: "ambient", aliases: [], group: .modes, description: "Toggle Ambient Overlay", argumentHint: nil),
        AmbientCommandSpec(name: "display", aliases: [], group: .modes, description: "Set display scope", argumentHint: "current|all"),
        AmbientCommandSpec(name: "intensity", aliases: [], group: .modes, description: "Set overlay intensity", argumentHint: "10-100"),
        AmbientCommandSpec(name: "cron", aliases: [], group: .automation, description: "Open cron settings", argumentHint: nil),
        AmbientCommandSpec(name: "actions", aliases: [], group: .automation, description: "Show queued actions", argumentHint: nil),
        AmbientCommandSpec(name: "skills", aliases: [], group: .automation, description: "Open skills settings", argumentHint: nil),
        AmbientCommandSpec(name: "nodes", aliases: [], group: .automation, description: "Open nodes/instances", argumentHint: nil),
    ])

    let commands: [AmbientCommandSpec]

    func parse(_ raw: String) -> AmbientParsedInput {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }
        guard trimmed.hasPrefix("/") else { return .prompt(trimmed) }

        let body = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return .unknown(name: "", suggestions: self.suggestions(for: "/")) }

        let parts = body.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
        let name = String(parts[0]).lowercased()
        let arguments = parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines) : ""

        if self.command(named: name) != nil {
            return .command(name: name, arguments: arguments)
        }

        return .unknown(name: name, suggestions: self.suggestions(for: "/\(name)"))
    }

    func suggestions(for raw: String) -> [AmbientCommandSpec] {
        let prefix = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .dropFirst(raw.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("/") ? 1 : 0)
            .lowercased()

        let matches = self.commands.filter { spec in
            prefix.isEmpty
                || spec.name.hasPrefix(prefix)
                || spec.aliases.contains(where: { $0.hasPrefix(prefix) })
        }

        return matches.sorted { lhs, rhs in
            if lhs.group != rhs.group { return lhs.group.rawValue < rhs.group.rawValue }
            return lhs.name < rhs.name
        }
    }

    func command(named raw: String) -> AmbientCommandSpec? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.commands.first { $0.name == name || $0.aliases.contains(name) }
    }
}
```

- [ ] **Step 4: Run parser tests and verify GREEN**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandRegistryTests
```

Expected: all `AmbientCommandRegistryTests` pass.

- [ ] **Step 5: Commit parser layer**

```bash
git add apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift
git commit -m "Add ambient command registry"
```

---

### Task 2: Composer Model State

**Files:**
- Create: `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift`

- [ ] **Step 1: Write failing model tests**

Create `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift`:

```swift
import Testing
@testable import OpenClaw

@MainActor
struct AmbientCommandDockModelTests {
    @Test func `typing slash exposes command suggestions`() {
        let model = AmbientCommandDockModel(registry: .default)

        model.inputText = "/ca"

        #expect(model.suggestions.map(\.name) == ["camera", "canvas"])
        #expect(model.thomasState == .focused)
    }

    @Test func `clear resets input and result`() {
        let model = AmbientCommandDockModel(registry: .default)
        model.inputText = "/help"
        model.result = .info("Commands")

        model.clear()

        #expect(model.inputText == "")
        #expect(model.result == .none)
        #expect(model.suggestions.isEmpty)
    }

    @Test func `selecting suggestion writes slash command with trailing space`() {
        let model = AmbientCommandDockModel(registry: .default)
        let canvas = AmbientCommandRegistry.default.command(named: "canvas")!

        model.acceptSuggestion(canvas)

        #expect(model.inputText == "/canvas ")
        #expect(model.suggestions.isEmpty)
    }
}
```

- [ ] **Step 2: Run model tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandDockModelTests
```

Expected: compile failure because `AmbientCommandDockModel` does not exist.

- [ ] **Step 3: Implement model**

Create `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`:

```swift
import Foundation
import Observation

@MainActor
@Observable
final class AmbientCommandDockModel {
    var inputText: String = "" {
        didSet { self.refreshSuggestions() }
    }

    private(set) var suggestions: [AmbientCommandSpec] = []
    var selectedSuggestionIndex: Int = 0
    var result: AmbientCommandResult = .none
    var thomasState: AmbientThomasOrbState = .ready
    var sessionLabel: String = "main session"
    var isSubmitting = false

    private let registry: AmbientCommandRegistry

    init(registry: AmbientCommandRegistry = .default) {
        self.registry = registry
    }

    func clear() {
        self.inputText = ""
        self.result = .none
        self.suggestions = []
        self.selectedSuggestionIndex = 0
        self.thomasState = .ready
    }

    func acceptSuggestion(_ suggestion: AmbientCommandSpec) {
        self.inputText = "\(suggestion.displayName) "
        self.suggestions = []
        self.selectedSuggestionIndex = 0
        self.result = .none
        self.thomasState = .focused
    }

    func moveSuggestionSelection(delta: Int) {
        guard !self.suggestions.isEmpty else { return }
        let next = self.selectedSuggestionIndex + delta
        self.selectedSuggestionIndex = min(max(next, 0), self.suggestions.count - 1)
    }

    func parsedInput() -> AmbientParsedInput {
        self.registry.parse(self.inputText)
    }

    private func refreshSuggestions() {
        let trimmed = self.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else {
            self.suggestions = []
            self.selectedSuggestionIndex = 0
            self.thomasState = trimmed.isEmpty ? .ready : .focused
            return
        }

        self.suggestions = Array(self.registry.suggestions(for: trimmed).prefix(8))
        self.selectedSuggestionIndex = min(self.selectedSuggestionIndex, max(self.suggestions.count - 1, 0))
        self.thomasState = .focused
    }
}
```

- [ ] **Step 4: Run model tests and verify GREEN**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandDockModelTests
```

Expected: all `AmbientCommandDockModelTests` pass.

- [ ] **Step 5: Commit model layer**

```bash
git add apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift
git commit -m "Add ambient command dock model"
```

---

### Task 3: Canvas-Like Thomas Orb Component

**Files:**
- Create: `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayViewSmokeTests.swift`

- [ ] **Step 1: Write failing Thomas orb tests**

Create `apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift`:

```swift
import Testing
import SwiftUI
@testable import OpenClaw

@MainActor
struct AmbientThomasOrbTests {
    @Test func `motion profiles match Canvas-like behavior by state`() {
        let ready = AmbientThomasOrbMotionProfile.profile(for: .ready)
        let sending = AmbientThomasOrbMotionProfile.profile(for: .sending)
        let error = AmbientThomasOrbMotionProfile.profile(for: .error)

        #expect(sending.orbitSeconds < ready.orbitSeconds)
        #expect(sending.pulseSeconds < ready.pulseSeconds)
        #expect(error.floatAmplitude < ready.floatAmplitude)
    }

    @Test func `Thomas orb view builds body for working state`() {
        let view = AmbientThomasOrbView(state: .working)

        _ = view.body
    }
}
```

- [ ] **Step 2: Run orb tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientThomasOrbTests
```

Expected: compile failure because `AmbientThomasOrbView` does not exist.

- [ ] **Step 3: Implement Thomas orb view**

Add to `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`:

```swift
import SwiftUI

struct AmbientThomasOrbView: View {
    let state: AmbientThomasOrbState

    var body: some View {
        let profile = AmbientThomasOrbMotionProfile.profile(for: self.state)

        TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            let floatY = sin(t * 2 * .pi / profile.pulseSeconds) * profile.floatAmplitude
            let floatX = cos(t * 2 * .pi / (profile.pulseSeconds * 1.7)) * (profile.floatAmplitude * 0.38)
            let spin = Angle.degrees((t.truncatingRemainder(dividingBy: profile.orbitSeconds) / profile.orbitSeconds) * 360)

            ZStack {
                Circle()
                    .stroke(self.ringColor.opacity(0.28), lineWidth: 1.2)
                    .scaleEffect(self.pulseScale(time: t, seconds: profile.pulseSeconds))
                    .opacity(self.pulseOpacity(time: t, seconds: profile.pulseSeconds))

                Circle()
                    .fill(
                        AngularGradient(
                            colors: [
                                .cyan,
                                .mint,
                                .yellow,
                                .pink,
                                .cyan,
                            ],
                            center: .center,
                            angle: spin))
                    .shadow(color: self.ringColor.opacity(profile.glowOpacity), radius: 26)
                    .padding(3)

                Circle()
                    .fill(.black.opacity(0.66))
                    .padding(9)

                Image("thomas_avatar", bundle: .module)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(.white.opacity(0.42), lineWidth: 2))
                    .padding(13)

                Circle()
                    .fill(self.statusColor)
                    .frame(width: 15, height: 15)
                    .overlay(Circle().stroke(.black.opacity(0.8), lineWidth: 2))
                    .offset(x: 29, y: 29)
            }
            .frame(width: 92, height: 92)
            .scaleEffect(self.breatheScale(time: t, seconds: profile.pulseSeconds))
            .offset(x: floatX, y: floatY)
            .accessibilityHidden(true)
        }
    }

    private var ringColor: Color {
        switch self.state {
        case .ready: .cyan
        case .focused: .mint
        case .sending: .yellow
        case .working: .cyan
        case .success: .green
        case .error: .orange
        }
    }

    private var statusColor: Color {
        switch self.state {
        case .ready, .focused: .mint
        case .sending, .working: .yellow
        case .success: .green
        case .error: .orange
        }
    }

    private func breatheScale(time: TimeInterval, seconds: Double) -> Double {
        1.0 + sin(time * 2 * .pi / seconds) * 0.035
    }

    private func pulseScale(time: TimeInterval, seconds: Double) -> Double {
        1.08 + (sin(time * 2 * .pi / seconds) + 1) * 0.14
    }

    private func pulseOpacity(time: TimeInterval, seconds: Double) -> Double {
        0.18 + (sin(time * 2 * .pi / seconds) + 1) * 0.12
    }
}
```

- [ ] **Step 4: Run orb tests and verify GREEN**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientThomasOrbTests
```

Expected: all `AmbientThomasOrbTests` pass.

- [ ] **Step 5: Commit Thomas orb**

```bash
git add apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift
git commit -m "Add ambient Thomas orb"
```

---

### Task 4: Composer UI And Keyboard Handling

**Files:**
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift`

- [ ] **Step 1: Write failing composer smoke tests**

Create `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift`:

```swift
import Testing
import SwiftUI
@testable import OpenClaw

@MainActor
struct AmbientCommandDockViewSmokeTests {
    @Test func `command dock view builds body`() {
        let model = AmbientCommandDockModel(registry: .default)
        let view = AmbientCommandDockView(model: model, onDismiss: {})

        _ = view.body
    }

    @Test func `suggestion row builds body`() {
        let spec = AmbientCommandRegistry.default.command(named: "canvas")!
        let view = AmbientCommandSuggestionRow(spec: spec, isSelected: true)

        _ = view.body
    }
}
```

- [ ] **Step 2: Run view tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandDockViewSmokeTests
```

Expected: compile failure because `AmbientCommandDockView` and `AmbientCommandSuggestionRow` do not exist.

- [ ] **Step 3: Implement composer view**

Append to `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`:

```swift
struct AmbientCommandDockView: View {
    @Bindable var model: AmbientCommandDockModel
    let onDismiss: () -> Void

    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 12) {
            AmbientThomasOrbView(state: self.model.thomasState)
                .frame(height: 112)

            VStack(spacing: 0) {
                self.header

                if !self.model.suggestions.isEmpty {
                    self.suggestionsList
                }

                self.resultStrip
                self.inputRow
            }
            .frame(width: 820)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.white.opacity(0.18), lineWidth: 1))
            .shadow(color: .black.opacity(0.30), radius: 28, x: 0, y: 18)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 16)
        .onAppear { self.focused = true }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(.mint)
                .frame(width: 8, height: 8)
                .shadow(color: .mint.opacity(0.7), radius: 8)
            Text("Thomas")
                .font(.system(size: 12, weight: .semibold))
            Text(self.model.sessionLabel)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
            Text("/help")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("Esc")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var suggestionsList: some View {
        VStack(spacing: 4) {
            ForEach(Array(self.model.suggestions.enumerated()), id: \.element.id) { index, spec in
                AmbientCommandSuggestionRow(spec: spec, isSelected: index == self.model.selectedSuggestionIndex)
                    .onTapGesture { self.model.acceptSuggestion(spec) }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var resultStrip: some View {
        switch self.model.result {
        case .none:
            EmptyView()
        case let .success(message), let .failure(message), let .info(message):
            Text(message)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
        }
    }

    private var inputRow: some View {
        TextField("Ask Thomas or type / for commands...", text: self.$model.inputText)
            .textFieldStyle(.plain)
            .focused(self.$focused)
            .font(.system(size: 14, weight: .regular))
            .padding(.horizontal, 13)
            .frame(height: 46)
            .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(.white.opacity(0.11), lineWidth: 1))
            .padding(.horizontal, 14)
            .padding(.bottom, 14)
    }
}

struct AmbientCommandSuggestionRow: View {
    let spec: AmbientCommandSpec
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Text(spec.displayName)
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .frame(width: 140, alignment: .leading)
            Text(spec.description)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
            Text(spec.group.title)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            isSelected ? .cyan.opacity(0.14) : .white.opacity(0.06),
            in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}
```

- [ ] **Step 4: Run view tests and verify GREEN**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandDockViewSmokeTests
```

Expected: all `AmbientCommandDockViewSmokeTests` pass.

- [ ] **Step 5: Commit composer view**

```bash
git add apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift
git commit -m "Add ambient command dock view"
```

---

### Task 5: Panel Integration

**Files:**
- Modify: `apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift`

- [ ] **Step 1: Write failing panel sizing test**

Add to `AmbientOverlayDisplayControllerTests`:

```swift
@Test func `command dock frame leaves room for floating Thomas orb`() {
    let display = AmbientOverlayDisplayController.DisplaySnapshot(
        info: AmbientOverlayDisplayInfo(id: "main", frame: CGRect(x: 0, y: 0, width: 1200, height: 800)),
        visibleFrame: CGRect(x: 0, y: 24, width: 1200, height: 740))

    let frame = AmbientOverlayDisplayController.commandDockFrame(for: display)

    #expect(frame.width == 868)
    #expect(frame.height == 236)
    #expect(frame.midX == display.visibleFrame.midX)
    #expect(frame.minY == display.visibleFrame.minY + 28)
}
```

- [ ] **Step 2: Run display tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayDisplayControllerTests
```

Expected: compile failure because `commandDockFrame(for:)` does not exist.

- [ ] **Step 3: Replace workspace panel content with command dock**

Modify `AmbientOverlayDisplayController`:

```swift
private var commandDockPanel: NSPanel?
private var commandDockHostingView: NSHostingView<AmbientCommandDockView>?
private var commandDockModel = AmbientCommandDockModel()

func showWorkspace(onDismiss: @escaping () -> Void, displayScope: AmbientOverlayDisplayScope) {
    let plan = Self.displayPlan(
        displays: Self.screenSnapshots(),
        mouseLocation: NSEvent.mouseLocation,
        scope: displayScope)
    let frame = Self.commandDockFrame(for: plan.workspaceDisplay)
    let panel = self.ensureCommandDockPanel(frame: frame, onDismiss: onDismiss)
    panel.setFrame(frame, display: true)
    panel.level = Self.workspaceWindowLevel
    panel.ignoresMouseEvents = false
    self.commandDockHostingView?.rootView = AmbientCommandDockView(
        model: self.commandDockModel,
        onDismiss: onDismiss)
    panel.orderFrontRegardless()
}

func hideWorkspace() {
    self.commandDockPanel?.orderOut(nil)
}

nonisolated static func commandDockFrame(for display: DisplaySnapshot?) -> NSRect {
    let screen = display?.visibleFrame ?? NSScreen.main?.visibleFrame ?? Self.screenFrame()
    let width = min(CGFloat(868), max(CGFloat(520), screen.width - 56))
    let size = NSSize(width: width, height: 236)
    let origin = CGPoint(x: screen.midX - size.width / 2, y: screen.minY + 28)
    return NSRect(origin: origin, size: size)
}

private func ensureCommandDockPanel(frame: NSRect, onDismiss: @escaping () -> Void) -> NSPanel {
    if let commandDockPanel {
        return commandDockPanel
    }

    let panel = OverlayPanelFactory.makePanel(
        contentRect: frame,
        level: Self.workspaceWindowLevel,
        hasShadow: false,
        acceptsMouseMovedEvents: true)
    panel.ignoresMouseEvents = false
    let host = NSHostingView(rootView: AmbientCommandDockView(model: self.commandDockModel, onDismiss: onDismiss))
    host.frame = NSRect(origin: .zero, size: frame.size)
    host.autoresizingMask = [.width, .height]
    panel.contentView = host
    self.commandDockHostingView = host
    self.commandDockPanel = panel
    return panel
}
```

Also update `close()` to close `commandDockPanel` and clear `commandDockHostingView`.

- [ ] **Step 4: Run display/controller tests and verify GREEN**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayDisplayControllerTests
swift test --filter AmbientOverlayExperienceControllerTests
```

Expected: both suites pass.

- [ ] **Step 5: Commit panel integration**

```bash
git add apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift \
  apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift
git commit -m "Show command dock in ambient overlay"
```

---

### Task 6: Command Execution And Prompt Sending

**Files:**
- Create: `apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`
- Test: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift`

- [ ] **Step 1: Write failing action tests**

Create `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift`:

```swift
import Testing
@testable import OpenClaw

@MainActor
struct AmbientCommandDockActionTests {
    @Test func `intensity command validates numeric range`() async {
        let executor = AmbientCommandDockActionExecutor(
            environment: .testing)

        let low = await executor.execute(name: "intensity", arguments: "5")
        let valid = await executor.execute(name: "intensity", arguments: "70")

        #expect(low == .failure("Usage: /intensity 10-100"))
        #expect(valid == .success("Ambient intensity set to 70%"))
    }

    @Test func `help command returns grouped command hint`() async {
        let executor = AmbientCommandDockActionExecutor(environment: .testing)

        let result = await executor.execute(name: "help", arguments: "")

        guard case let .info(message) = result else {
            Issue.record("Expected info")
            return
        }
        #expect(message.contains("/canvas"))
        #expect(message.contains("/restart-gateway"))
    }
}
```

- [ ] **Step 2: Run action tests and verify RED**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandDockActionTests
```

Expected: compile failure because `AmbientCommandDockActionExecutor` does not exist.

- [ ] **Step 3: Implement action executor with testing environment**

Create `apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift`:

```swift
import AppKit
import Foundation

struct AmbientCommandDockActionEnvironment {
    var setIntensity: @MainActor (Double) -> Void
    var dismiss: @MainActor () -> Void
    var openCanvas: @MainActor () async -> AmbientCommandResult
    var openChat: @MainActor () async -> AmbientCommandResult
    var openSettings: @MainActor (SettingsTab) -> Void
    var openLogs: @MainActor () -> Void
    var restartGateway: @MainActor () -> Void

    static var live: AmbientCommandDockActionEnvironment {
        AmbientCommandDockActionEnvironment(
            setIntensity: { percent in
                AppStateStore.shared.ambientOverlayIntensity = percent / 100.0
            },
            dismiss: {
                AmbientOverlayExperienceController.shared.dismissInteractive(reason: .closeButton)
            },
            openCanvas: {
                let sessionKey = await GatewayConnection.shared.mainSessionKey()
                do {
                    _ = try CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
                    return .success("Canvas opened")
                } catch {
                    return .failure(error.localizedDescription)
                }
            },
            openChat: {
                let sessionKey = await WebChatManager.shared.preferredSessionKey()
                WebChatManager.shared.show(sessionKey: sessionKey)
                return .success("Chat opened")
            },
            openSettings: { tab in
                SettingsTabRouter.request(tab)
                SettingsWindowOpener.shared.open()
            },
            openLogs: { DebugActions.openLog() },
            restartGateway: { DebugActions.restartGateway() })
    }

    static var testing: AmbientCommandDockActionEnvironment {
        AmbientCommandDockActionEnvironment(
            setIntensity: { _ in },
            dismiss: {},
            openCanvas: { .success("Canvas opened") },
            openChat: { .success("Chat opened") },
            openSettings: { _ in },
            openLogs: {},
            restartGateway: {})
    }
}

struct AmbientCommandDockActionExecutor {
    var registry: AmbientCommandRegistry = .default
    var environment: AmbientCommandDockActionEnvironment = .live

    @MainActor
    func execute(name: String, arguments: String) async -> AmbientCommandResult {
        switch name {
        case "help":
            let names = self.registry.commands.prefix(12).map(\.displayName).joined(separator: "  ")
            return .info("Commands: \(names)")
        case "clear":
            return .success("Cleared")
        case "dismiss":
            self.environment.dismiss()
            return .success("Dismissed")
        case "intensity":
            guard let value = Double(arguments.trimmingCharacters(in: .whitespacesAndNewlines)),
                  (10...100).contains(value)
            else {
                return .failure("Usage: /intensity 10-100")
            }
            self.environment.setIntensity(value)
            return .success("Ambient intensity set to \(Int(value.rounded()))%")
        case "canvas":
            return await self.environment.openCanvas()
        case "chat":
            return await self.environment.openChat()
        case "settings":
            self.environment.openSettings(.general)
            return .success("Settings opened")
        case "logs":
            self.environment.openLogs()
            return .success("Logs opened")
        case "restart-gateway":
            self.environment.restartGateway()
            return .success("Gateway restart requested")
        case "status":
            return .info("OpenClaw status is available from the menu and health check.")
        default:
            return .failure("Command /\(name) is not wired yet")
        }
    }
}
```

- [ ] **Step 4: Wire model submission**

Add to `AmbientCommandDockModel`:

```swift
private let actions: AmbientCommandDockActionExecutor

init(
    registry: AmbientCommandRegistry = .default,
    actions: AmbientCommandDockActionExecutor = AmbientCommandDockActionExecutor())
{
    self.registry = registry
    self.actions = actions
}

func submit() async {
    let parsed = self.parsedInput()
    switch parsed {
    case .empty:
        return
    case let .prompt(message):
        self.isSubmitting = true
        self.thomasState = .sending
        let result = await VoiceWakeForwarder.forward(
            transcript: message,
            options: await VoiceWakeForwarder.selectedSessionOptions())
        self.isSubmitting = false
        switch result {
        case .success:
            self.inputText = ""
            self.result = .success("Sent to Thomas")
            self.thomasState = .success
        case let .failure(error):
            self.result = .failure(error.localizedDescription)
            self.thomasState = .error
        }
    case let .command(name, arguments):
        self.thomasState = .sending
        let outcome = await self.actions.execute(name: name, arguments: arguments)
        self.result = outcome
        self.inputText = ""
        self.thomasState = switch outcome {
        case .failure: .error
        case .none, .info, .success: .success
        }
    case let .unknown(name, suggestions):
        let hint = suggestions.prefix(3).map(\.displayName).joined(separator: ", ")
        self.result = .failure(hint.isEmpty ? "Unknown command /\(name)" : "Unknown command /\(name). Try \(hint)")
        self.thomasState = .error
    }
}
```

- [ ] **Step 5: Run action/model tests and verify GREEN**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientCommandDockActionTests
swift test --filter AmbientCommandDockModelTests
```

Expected: both suites pass.

- [ ] **Step 6: Commit action layer**

```bash
git add apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift
git commit -m "Wire ambient command actions"
```

---

### Task 7: Final Verification And Manual Smoke

**Files:**
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
- Modify: `apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift`
- Modify: `apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift`

- [ ] **Step 1: Run focused ambient tests**

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter Ambient
```

Expected: all ambient-related tests pass.

- [ ] **Step 2: Run full macOS tests**

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test
```

Expected: all tests pass.

- [ ] **Step 3: Build and run installed app**

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw
./script/build_and_run.sh --verify
```

Expected: build succeeds and `/Applications/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only` is running.

- [ ] **Step 4: Manual smoke checklist**

Run manually in the app:

- Enable Ambient Overlay in Settings > General.
- Press `Control-Option-Space`.
- Confirm Thomas floats as a Canvas-like orb above the composer.
- Type `/` and confirm suggestions appear.
- Type `/intensity 70`, press Enter, and confirm ambient intensity updates.
- Type `/canvas`, press Enter, and confirm Canvas opens.
- Type a plain prompt, press Enter, and confirm it sends or returns a clear gateway error.
- Press `Escape` and confirm suggestions/composer dismiss predictably.
- Confirm click-through still works outside the composer.

- [ ] **Step 5: Commit final verification adjustments**

```bash
git status -sb
git add apps/macos/Sources/OpenClaw/AmbientCommandDockModels.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandRegistry.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockModel.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockActions.swift \
  apps/macos/Sources/OpenClaw/AmbientCommandDockViews.swift \
  apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift \
  apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandRegistryTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockModelTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockActionTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientCommandDockViewSmokeTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientThomasOrbTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientOverlayDisplayControllerTests.swift \
  apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift
git commit -m "Complete ambient command dock"
```

---

## Self-Review

- Spec coverage: parser, rich command foundation, chat composer, Thomas floating Canvas-like orb, panel integration, local commands, prompt sending, keyboard behavior, and verification are covered.
- Incomplete-marker scan: no unfinished-work markers are intentionally present.
- Type consistency: the plan consistently uses `AmbientCommandDockModel`, `AmbientCommandRegistry`, `AmbientCommandDockActionExecutor`, `AmbientCommandDockView`, and `AmbientThomasOrbView`.
