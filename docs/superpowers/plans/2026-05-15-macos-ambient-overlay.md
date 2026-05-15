# macOS Ambient Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first usable macOS ambient overlay slice: a current-display click-through ambient layer, hotkey/menu arming, a native bottom workspace sheet, settings, and tests.

**Architecture:** Reuse the existing macOS SwiftPM app, `OverlayPanelFactory`, menu-bar state, and Swift Testing patterns. Keep passive visuals and interactive controls in separate `NSPanel` instances so idle mode is always click-through and armed mode only exposes visible controls.

**Tech Stack:** Swift 6, AppKit `NSPanel`, SwiftUI, Observation, `UserDefaults`, Swift Testing, existing OpenClaw macOS app package.

---

## File Structure

- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayModels.swift`
  - Pure overlay state, settings, display-scope model, and display target resolution.
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`
  - `@MainActor` state machine, settings bridge, display-controller lifecycle, arm/dismiss timeout behavior.
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
  - Per-display AppKit panel ownership: ambient panel plus bottom workspace panel.
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayViews.swift`
  - Native SwiftUI ambient and workspace surfaces.
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayHotkey.swift`
  - Global/local monitor controller and pure hotkey matcher for `Control+Option+Space`.
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/Constants.swift`
  - Add stable defaults keys.
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AppState.swift`
  - Persist enabled flag, display scope, intensity, and timeout.
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuContentView.swift`
  - Add menu toggle and fallback button.
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuBar.swift`
  - Start and stop the overlay controller and hotkey when app state changes.
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/GeneralSettings.swift`
  - Add General settings controls.
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayModelsTests.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayHotkeyTests.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayViewSmokeTests.swift`
- Modify test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/SettingsViewSmokeTests.swift`

## Task 1: Models And Persisted Settings

**Files:**
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayModels.swift`
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/Constants.swift`
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AppState.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayModelsTests.swift`

- [ ] **Step 1: Write failing model tests**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayModelsTests.swift`:

```swift
import CoreGraphics
import Testing
@testable import OpenClaw

struct AmbientOverlayModelsTests {
    @Test func `current display resolves from mouse location`() {
        let left = AmbientOverlayDisplayInfo(
            id: "left",
            frame: CGRect(x: -1440, y: 0, width: 1440, height: 900))
        let main = AmbientOverlayDisplayInfo(
            id: "main",
            frame: CGRect(x: 0, y: 0, width: 1728, height: 1117))

        let targets = AmbientOverlayDisplayResolver.targetDisplays(
            displays: [left, main],
            mouseLocation: CGPoint(x: 200, y: 300),
            scope: .currentDisplay)

        #expect(targets == [main])
    }

    @Test func `all displays preserves screen order`() {
        let left = AmbientOverlayDisplayInfo(
            id: "left",
            frame: CGRect(x: -1440, y: 0, width: 1440, height: 900))
        let main = AmbientOverlayDisplayInfo(
            id: "main",
            frame: CGRect(x: 0, y: 0, width: 1728, height: 1117))

        let targets = AmbientOverlayDisplayResolver.targetDisplays(
            displays: [left, main],
            mouseLocation: CGPoint(x: 200, y: 300),
            scope: .allDisplays)

        #expect(targets == [left, main])
    }

    @Test func `current display falls back to first display`() {
        let first = AmbientOverlayDisplayInfo(
            id: "first",
            frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let second = AmbientOverlayDisplayInfo(
            id: "second",
            frame: CGRect(x: 100, y: 0, width: 100, height: 100))

        let targets = AmbientOverlayDisplayResolver.targetDisplays(
            displays: [first, second],
            mouseLocation: CGPoint(x: 500, y: 500),
            scope: .currentDisplay)

        #expect(targets == [first])
    }

    @Test func `settings normalize invalid persisted values`() {
        #expect(AmbientOverlayDisplayScope(rawValue: "currentDisplay") == .currentDisplay)
        #expect(AmbientOverlayDisplayScope(rawValue: "allDisplays") == .allDisplays)
        #expect(AmbientOverlayDisplayScope(rawValue: "bad-value") == nil)
    }
}
```

- [ ] **Step 2: Run the failing model tests**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayModelsTests
```

Expected: failure because `AmbientOverlayDisplayInfo`, `AmbientOverlayDisplayResolver`, and `AmbientOverlayDisplayScope` do not exist.

- [ ] **Step 3: Add defaults keys**

Append these constants in `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/Constants.swift` near the other OpenClaw defaults keys:

```swift
let ambientOverlayEnabledKey = "openclaw.ambientOverlayEnabled"
let ambientOverlayDisplayScopeKey = "openclaw.ambientOverlayDisplayScope"
let ambientOverlayIntensityKey = "openclaw.ambientOverlayIntensity"
let ambientOverlayTimeoutSecondsKey = "openclaw.ambientOverlayTimeoutSeconds"
```

- [ ] **Step 4: Add the pure overlay model file**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayModels.swift`:

```swift
import CoreGraphics
import Foundation

enum AmbientOverlayState: Equatable {
    case idle
    case arming
    case armed
    case executing
    case cooldown
}

enum AmbientOverlayDisplayScope: String, CaseIterable, Identifiable {
    case currentDisplay
    case allDisplays

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .currentDisplay:
            "Current Display"
        case .allDisplays:
            "All Displays"
        }
    }
}

struct AmbientOverlayDisplayInfo: Equatable, Identifiable {
    let id: String
    let frame: CGRect
}

struct AmbientOverlaySettings: Equatable {
    var isEnabled: Bool
    var displayScope: AmbientOverlayDisplayScope
    var intensity: Double
    var timeoutSeconds: Double

    static let defaultIntensity = 0.42
    static let defaultTimeoutSeconds = 30.0

    static var defaults: AmbientOverlaySettings {
        AmbientOverlaySettings(
            isEnabled: false,
            displayScope: .currentDisplay,
            intensity: Self.defaultIntensity,
            timeoutSeconds: Self.defaultTimeoutSeconds)
    }
}

enum AmbientOverlayDisplayResolver {
    static func targetDisplays(
        displays: [AmbientOverlayDisplayInfo],
        mouseLocation: CGPoint,
        scope: AmbientOverlayDisplayScope
    ) -> [AmbientOverlayDisplayInfo] {
        guard !displays.isEmpty else { return [] }

        switch scope {
        case .allDisplays:
            return displays
        case .currentDisplay:
            if let current = displays.first(where: { $0.frame.contains(mouseLocation) }) {
                return [current]
            }
            return [displays[0]]
        }
    }
}
```

- [ ] **Step 5: Persist settings in AppState**

Add these properties to `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AppState.swift` near `canvasEnabled`:

```swift
var ambientOverlayEnabled: Bool {
    didSet {
        self.ifNotPreview {
            UserDefaults.standard.set(self.ambientOverlayEnabled, forKey: ambientOverlayEnabledKey)
        }
    }
}

var ambientOverlayDisplayScope: AmbientOverlayDisplayScope {
    didSet {
        self.ifNotPreview {
            UserDefaults.standard.set(self.ambientOverlayDisplayScope.rawValue, forKey: ambientOverlayDisplayScopeKey)
        }
    }
}

var ambientOverlayIntensity: Double {
    didSet {
        self.ifNotPreview {
            UserDefaults.standard.set(self.ambientOverlayIntensity, forKey: ambientOverlayIntensityKey)
        }
    }
}

var ambientOverlayTimeoutSeconds: Double {
    didSet {
        self.ifNotPreview {
            UserDefaults.standard.set(self.ambientOverlayTimeoutSeconds, forKey: ambientOverlayTimeoutSecondsKey)
        }
    }
}
```

Initialize them in `init(preview:)` after `self.canvasEnabled = ...`:

```swift
if let storedAmbientEnabled = UserDefaults.standard.object(forKey: ambientOverlayEnabledKey) as? Bool {
    self.ambientOverlayEnabled = storedAmbientEnabled
} else {
    self.ambientOverlayEnabled = false
}
let storedAmbientScope = UserDefaults.standard.string(forKey: ambientOverlayDisplayScopeKey)
if let storedAmbientScope,
   let parsedAmbientScope = AmbientOverlayDisplayScope(rawValue: storedAmbientScope)
{
    self.ambientOverlayDisplayScope = parsedAmbientScope
} else {
    self.ambientOverlayDisplayScope = .currentDisplay
}
if let storedAmbientIntensity = UserDefaults.standard.object(forKey: ambientOverlayIntensityKey) as? Double {
    self.ambientOverlayIntensity = storedAmbientIntensity
} else {
    self.ambientOverlayIntensity = AmbientOverlaySettings.defaultIntensity
}
if let storedAmbientTimeout = UserDefaults.standard.object(forKey: ambientOverlayTimeoutSecondsKey) as? Double {
    self.ambientOverlayTimeoutSeconds = storedAmbientTimeout
} else {
    self.ambientOverlayTimeoutSeconds = AmbientOverlaySettings.defaultTimeoutSeconds
}
```

- [ ] **Step 6: Verify models and commit**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayModelsTests
```

Expected: pass.

Commit:

```bash
git add /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayModels.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/Constants.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AppState.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayModelsTests.swift
git commit -m "Add ambient overlay settings model"
```

## Task 2: Experience Controller State Machine

**Files:**
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift`

- [ ] **Step 1: Write failing controller tests**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift`:

```swift
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AmbientOverlayExperienceControllerTests {
    @Test func `disabled controller hides surfaces and stays idle`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)

        controller.setEnabled(false)
        controller.toggleArmed()

        #expect(controller.overlayState == .idle)
        #expect(controller.isEnabled == false)
    }

    @Test func `enabled controller toggles armed state`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)

        controller.setEnabled(true)
        controller.toggleArmed()
        #expect(controller.overlayState == .armed)

        controller.toggleArmed()
        #expect(controller.overlayState == .idle)
    }

    @Test func `escape dismiss returns to idle`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)

        controller.setEnabled(true)
        controller.arm()
        controller.dismissInteractive(reason: .escape)

        #expect(controller.overlayState == .idle)
    }

    @Test func `settings update refreshes public settings snapshot`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)

        controller.applySettings(
            AmbientOverlaySettings(
                isEnabled: true,
                displayScope: .allDisplays,
                intensity: 0.7,
                timeoutSeconds: 12))

        #expect(controller.settings.displayScope == .allDisplays)
        #expect(controller.settings.intensity == 0.7)
        #expect(controller.settings.timeoutSeconds == 12)
    }
}
```

- [ ] **Step 2: Run the failing controller tests**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayExperienceControllerTests
```

Expected: failure because `AmbientOverlayExperienceController` does not exist.

- [ ] **Step 3: Implement the controller without window code**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`:

```swift
import Foundation
import Observation

@MainActor
@Observable
final class AmbientOverlayExperienceController {
    static let shared = AmbientOverlayExperienceController()

    enum DismissReason: Equatable {
        case closeButton
        case escape
        case hotkey
        case timeout
        case disabled
    }

    private let enableUI: Bool
    private var timeoutTask: Task<Void, Never>?
    var showAmbient: ((Double) -> Void)?
    var showWorkspace: (((@escaping () -> Void)) -> Void)?
    var hideWorkspace: (() -> Void)?
    var closeSurfaces: (() -> Void)?

    private(set) var overlayState: AmbientOverlayState = .idle
    private(set) var settings: AmbientOverlaySettings = .defaults

    var isEnabled: Bool {
        self.settings.isEnabled
    }

    init(enableUI: Bool = true) {
        self.enableUI = enableUI
    }

    deinit {
        self.timeoutTask?.cancel()
    }

    func applySettings(_ settings: AmbientOverlaySettings) {
        self.settings = settings
        self.setEnabled(settings.isEnabled)
        if settings.isEnabled {
            self.showAmbient?(settings.intensity)
        }
    }

    func setEnabled(_ enabled: Bool) {
        self.settings.isEnabled = enabled

        guard enabled else {
            self.dismissInteractive(reason: .disabled)
            self.closeSurfaces?()
            return
        }

        self.showAmbientIfNeeded()
    }

    func toggleArmed() {
        guard self.settings.isEnabled else {
            self.overlayState = .idle
            return
        }

        switch self.overlayState {
        case .idle, .cooldown:
            self.arm()
        case .arming, .armed, .executing:
            self.dismissInteractive(reason: .hotkey)
        }
    }

    func arm() {
        guard self.settings.isEnabled else {
            self.overlayState = .idle
            return
        }

        self.overlayState = .arming
        self.showAmbientIfNeeded()
        self.overlayState = .armed
        self.showWorkspace?({ [weak self] in
            Task { @MainActor in
                self?.dismissInteractive(reason: .closeButton)
            }
        })
        self.scheduleTimeout()
    }

    func dismissInteractive(reason: DismissReason) {
        self.timeoutTask?.cancel()
        self.timeoutTask = nil
        self.hideWorkspace?()
        self.overlayState = .idle
    }

    private func showAmbientIfNeeded() {
        guard self.enableUI else { return }
        self.showAmbient?(self.settings.intensity)
    }

    private func scheduleTimeout() {
        self.timeoutTask?.cancel()
        let seconds = self.settings.timeoutSeconds
        self.timeoutTask = Task { [weak self] in
            let nanoseconds = UInt64(max(seconds, 1) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.dismissInteractive(reason: .timeout)
            }
        }
    }
}
```

- [ ] **Step 4: Run controller tests and commit**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayExperienceControllerTests
```

Expected: pass.

Commit after Task 3 compiles the package:

```bash
git add /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift
git commit -m "Add ambient overlay state controller"
```

## Task 3: Panels And SwiftUI Surfaces

**Files:**
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayViews.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayViewSmokeTests.swift`

- [ ] **Step 1: Write SwiftUI smoke tests**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayViewSmokeTests.swift`:

```swift
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AmbientOverlayViewSmokeTests {
    @Test func `ambient overlay view builds body`() {
        let view = AmbientOverlayView(intensity: 0.42)
        _ = view.body
    }

    @Test func `workspace sheet builds body`() {
        let view = AmbientWorkspaceSheetView(onClose: {})
        _ = view.body
    }
}
```

- [ ] **Step 2: Run the failing view tests**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayViewSmokeTests
```

Expected: failure because the SwiftUI views do not exist.

- [ ] **Step 3: Implement native SwiftUI views**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayViews.swift`:

```swift
import SwiftUI

struct AmbientOverlayView: View {
    let intensity: Double

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.clear)

            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.cyan.opacity(0.18 * self.intensity),
                            Color.white.opacity(0.10 * self.intensity),
                            Color.mint.opacity(0.16 * self.intensity),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing),
                    lineWidth: 2)
                .padding(10)
                .shadow(color: .cyan.opacity(0.22 * self.intensity), radius: 24)
        }
        .ignoresSafeArea()
    }
}

struct AmbientWorkspaceSheetView: View {
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "sparkles")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.cyan)

            VStack(alignment: .leading, spacing: 2) {
                Text("OpenClaw Ambient")
                    .font(.headline)
                Text("Ready for an instruction")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 20)

            Button {
                self.onClose()
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .help("Close Ambient Overlay")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: 520)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(Color.white.opacity(0.16), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.24), radius: 24, y: 12)
    }
}
```

- [ ] **Step 4: Implement panel ownership**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift`:

```swift
import AppKit
import SwiftUI

@MainActor
final class AmbientOverlayDisplayController {
    private var ambientPanel: NSPanel?
    private var workspacePanel: NSPanel?

    func showAmbient(intensity: Double) {
        let screenFrame: NSRect
        if let mainFrame = NSScreen.main?.frame {
            screenFrame = mainFrame
        } else {
            screenFrame = NSRect(x: 0, y: 0, width: 1200, height: 800)
        }
        let panel: NSPanel
        if let existingAmbientPanel = self.ambientPanel {
            panel = existingAmbientPanel
        } else {
            panel = self.makeAmbientPanel(frame: screenFrame)
        }
        panel.setFrame(screenFrame, display: true)
        panel.contentView = NSHostingView(rootView: AmbientOverlayView(intensity: intensity))
        panel.orderFrontRegardless()
        self.ambientPanel = panel
    }

    func updateIntensity(_ intensity: Double) {
        self.ambientPanel?.contentView = NSHostingView(rootView: AmbientOverlayView(intensity: intensity))
    }

    func showWorkspace(onDismiss: @escaping () -> Void) {
        let screenFrame: NSRect
        if let mainFrame = NSScreen.main?.frame {
            screenFrame = mainFrame
        } else {
            screenFrame = NSRect(x: 0, y: 0, width: 1200, height: 800)
        }
        let size = NSSize(width: 560, height: 92)
        let origin = NSPoint(
            x: screenFrame.midX - size.width / 2,
            y: screenFrame.minY + 56)
        let frame = NSRect(origin: origin, size: size)
        let panel: NSPanel
        if let existingWorkspacePanel = self.workspacePanel {
            panel = existingWorkspacePanel
        } else {
            panel = OverlayPanelFactory.makePanel(
                contentRect: frame,
                level: .floating,
                hasShadow: false,
                acceptsMouseMovedEvents: true)
        }

        panel.ignoresMouseEvents = false
        panel.contentView = NSHostingView(rootView: AmbientWorkspaceSheetView(onClose: onDismiss))
        panel.setFrame(frame, display: true)
        panel.orderFrontRegardless()
        self.workspacePanel = panel
    }

    func hideWorkspace() {
        self.workspacePanel?.orderOut(nil)
    }

    func close() {
        self.workspacePanel?.close()
        self.ambientPanel?.close()
        self.workspacePanel = nil
        self.ambientPanel = nil
    }

    private func makeAmbientPanel(frame: NSRect) -> NSPanel {
        let panel = OverlayPanelFactory.makePanel(
            contentRect: frame,
            level: .screenSaver,
            hasShadow: false,
            acceptsMouseMovedEvents: false)
        panel.ignoresMouseEvents = true
        return panel
    }
}
```

- [ ] **Step 5: Connect the display controller to the experience controller**

In `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift`, add this property near the other private properties:

```swift
private var displayController: AmbientOverlayDisplayController?
```

Then replace `showAmbientIfNeeded()` with:

```swift
private func showAmbientIfNeeded() {
    guard self.enableUI else { return }
    if self.displayController == nil {
        let controller = AmbientOverlayDisplayController()
        self.showAmbient = { [weak controller] intensity in
            controller?.showAmbient(intensity: intensity)
        }
        self.showWorkspace = { [weak controller] onDismiss in
            controller?.showWorkspace(onDismiss: onDismiss)
        }
        self.hideWorkspace = { [weak controller] in
            controller?.hideWorkspace()
        }
        self.closeSurfaces = { [weak controller] in
            controller?.close()
        }
        self.displayController = controller
    }
    self.showAmbient?(self.settings.intensity)
}
```

And in `setEnabled(_:)`, replace the disabled branch with:

```swift
guard enabled else {
    self.dismissInteractive(reason: .disabled)
    self.closeSurfaces?()
    self.displayController = nil
    self.showAmbient = nil
    self.showWorkspace = nil
    self.hideWorkspace = nil
    self.closeSurfaces = nil
    return
}
```

- [ ] **Step 6: Run panel and controller tests, then commit**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayViewSmokeTests
swift test --filter AmbientOverlayExperienceControllerTests
```

Expected: pass.

Commit:

```bash
git add /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayDisplayController.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayViews.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayExperienceController.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayViewSmokeTests.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayExperienceControllerTests.swift
git commit -m "Add ambient overlay panels"
```

## Task 4: Hotkey, Menu Fallback, And App Wiring

**Files:**
- Create: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayHotkey.swift`
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuContentView.swift`
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuBar.swift`
- Test: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayHotkeyTests.swift`

- [ ] **Step 1: Write failing hotkey matcher tests**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayHotkeyTests.swift`:

```swift
import AppKit
import Testing
@testable import OpenClaw

struct AmbientOverlayHotkeyTests {
    @Test func `control option space matches`() {
        #expect(AmbientOverlayHotkeyMatcher.matches(
            keyCode: 49,
            modifierFlags: [.control, .option]) == true)
    }

    @Test func `option space without control does not match`() {
        #expect(AmbientOverlayHotkeyMatcher.matches(
            keyCode: 49,
            modifierFlags: [.option]) == false)
    }

    @Test func `control option return does not match`() {
        #expect(AmbientOverlayHotkeyMatcher.matches(
            keyCode: 36,
            modifierFlags: [.control, .option]) == false)
    }
}
```

- [ ] **Step 2: Run the failing hotkey tests**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayHotkeyTests
```

Expected: failure because `AmbientOverlayHotkeyMatcher` does not exist.

- [ ] **Step 3: Implement the hotkey controller**

Create `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayHotkey.swift`:

```swift
import AppKit

enum AmbientOverlayHotkeyMatcher {
    static let spaceKeyCode: UInt16 = 49

    static func matches(keyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) -> Bool {
        let deviceIndependentFlags = modifierFlags.intersection(.deviceIndependentFlagsMask)
        return keyCode == Self.spaceKeyCode
            && deviceIndependentFlags.contains(.control)
            && deviceIndependentFlags.contains(.option)
            && !deviceIndependentFlags.contains(.command)
            && !deviceIndependentFlags.contains(.shift)
    }
}

@MainActor
final class AmbientOverlayHotkeyController {
    static let shared = AmbientOverlayHotkeyController()

    private var globalMonitor: Any?
    private var localMonitor: Any?
    private var isEnabled = false

    func setEnabled(_ enabled: Bool) {
        guard enabled != self.isEnabled else { return }
        self.isEnabled = enabled

        if enabled {
            self.install()
        } else {
            self.remove()
        }
    }

    private func install() {
        self.remove()

        self.globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            guard AmbientOverlayHotkeyMatcher.matches(
                keyCode: event.keyCode,
                modifierFlags: event.modifierFlags)
            else { return }

            Task { @MainActor in
                AmbientOverlayExperienceController.shared.toggleArmed()
            }
        }

        self.localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard AmbientOverlayHotkeyMatcher.matches(
                keyCode: event.keyCode,
                modifierFlags: event.modifierFlags)
            else { return event }

            AmbientOverlayExperienceController.shared.toggleArmed()
            return nil
        }
    }

    private func remove() {
        if let globalMonitor {
            NSEvent.removeMonitor(globalMonitor)
        }
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
        }
        self.globalMonitor = nil
        self.localMonitor = nil
    }
}
```

- [ ] **Step 4: Add menu toggle and fallback activation**

In `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuContentView.swift`, add this block immediately after the existing "Allow Canvas" toggle block:

```swift
Toggle(
    isOn: Binding(
        get: { self.state.ambientOverlayEnabled },
        set: { self.state.ambientOverlayEnabled = $0 }))
{
    Label("Ambient Overlay", systemImage: "sparkles.rectangle.stack")
}
Button {
    AmbientOverlayExperienceController.shared.arm()
} label: {
    Label("Open Ambient Overlay", systemImage: "rectangle.inset.filled.and.person.filled")
}
.disabled(!self.state.ambientOverlayEnabled)
```

- [ ] **Step 5: Wire app lifecycle**

In `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuBar.swift`, add this scene modifier after the existing `.onChange(of: self.state.connectionMode)` block:

```swift
.task {
    AmbientOverlayExperienceController.shared.applySettings(
        AmbientOverlaySettings(
            isEnabled: self.state.ambientOverlayEnabled,
            displayScope: self.state.ambientOverlayDisplayScope,
            intensity: self.state.ambientOverlayIntensity,
            timeoutSeconds: self.state.ambientOverlayTimeoutSeconds))
    AmbientOverlayHotkeyController.shared.setEnabled(self.state.ambientOverlayEnabled)
}
.onChange(of: self.state.ambientOverlayEnabled) { _, enabled in
    AmbientOverlayExperienceController.shared.applySettings(
        AmbientOverlaySettings(
            isEnabled: enabled,
            displayScope: self.state.ambientOverlayDisplayScope,
            intensity: self.state.ambientOverlayIntensity,
            timeoutSeconds: self.state.ambientOverlayTimeoutSeconds))
    AmbientOverlayHotkeyController.shared.setEnabled(enabled)
}
.onChange(of: self.state.ambientOverlayDisplayScope) { _, _ in
    AmbientOverlayExperienceController.shared.applySettings(
        AmbientOverlaySettings(
            isEnabled: self.state.ambientOverlayEnabled,
            displayScope: self.state.ambientOverlayDisplayScope,
            intensity: self.state.ambientOverlayIntensity,
            timeoutSeconds: self.state.ambientOverlayTimeoutSeconds))
}
.onChange(of: self.state.ambientOverlayIntensity) { _, _ in
    AmbientOverlayExperienceController.shared.applySettings(
        AmbientOverlaySettings(
            isEnabled: self.state.ambientOverlayEnabled,
            displayScope: self.state.ambientOverlayDisplayScope,
            intensity: self.state.ambientOverlayIntensity,
            timeoutSeconds: self.state.ambientOverlayTimeoutSeconds))
}
.onChange(of: self.state.ambientOverlayTimeoutSeconds) { _, _ in
    AmbientOverlayExperienceController.shared.applySettings(
        AmbientOverlaySettings(
            isEnabled: self.state.ambientOverlayEnabled,
            displayScope: self.state.ambientOverlayDisplayScope,
            intensity: self.state.ambientOverlayIntensity,
            timeoutSeconds: self.state.ambientOverlayTimeoutSeconds))
}
```

- [ ] **Step 6: Run hotkey tests and commit**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlayHotkeyTests
swift test --filter AmbientOverlayExperienceControllerTests
```

Expected: pass.

Commit:

```bash
git add /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/AmbientOverlayHotkey.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuContentView.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/MenuBar.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/AmbientOverlayHotkeyTests.swift
git commit -m "Wire ambient overlay activation"
```

## Task 5: Settings UI, Verification, And Manual QA

**Files:**
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/GeneralSettings.swift`
- Modify: `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/SettingsViewSmokeTests.swift`

- [ ] **Step 1: Extend General settings**

In `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/GeneralSettings.swift`, insert this block after the existing "Allow Canvas" settings row:

```swift
SettingsToggleRow(
    title: "Ambient Overlay",
    subtitle: "Show a click-through AI layer that can be armed with Control-Option-Space.",
    binding: self.$state.ambientOverlayEnabled)

if self.state.ambientOverlayEnabled {
    Picker("Display scope", selection: self.$state.ambientOverlayDisplayScope) {
        ForEach(AmbientOverlayDisplayScope.allCases) { scope in
            Text(scope.title).tag(scope)
        }
    }
    .pickerStyle(.segmented)
    .frame(maxWidth: 320, alignment: .leading)

    HStack(spacing: 12) {
        Text("Ambient intensity")
            .font(.callout.weight(.semibold))
        Slider(value: self.$state.ambientOverlayIntensity, in: 0.1...1.0)
            .frame(width: 180)
        Text("\(Int(self.state.ambientOverlayIntensity * 100))%")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(width: 42, alignment: .trailing)
    }

    HStack(spacing: 12) {
        Text("Armed timeout")
            .font(.callout.weight(.semibold))
        Stepper(
            "\(Int(self.state.ambientOverlayTimeoutSeconds)) seconds",
            value: self.$state.ambientOverlayTimeoutSeconds,
            in: 5...120,
            step: 5)
    }
}
```

- [ ] **Step 2: Make the settings smoke test exercise the expanded body**

Update `/Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/SettingsViewSmokeTests.swift` inside `general settings builds body`:

```swift
@Test func `general settings builds body`() {
    let state = AppState(preview: true)
    state.ambientOverlayEnabled = true
    let view = GeneralSettings(state: state)
    _ = view.body
}
```

- [ ] **Step 3: Run targeted tests**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlay
swift test --filter SettingsViewSmokeTests/general
```

Expected: all targeted tests pass.

- [ ] **Step 4: Run package build**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift build
```

Expected: build completes without compile errors.

- [ ] **Step 5: Manual QA on macOS**

Run the macOS app from Xcode or the existing app launch path, then verify:

```text
1. Enable Ambient Overlay in Settings > General.
2. Confirm a subtle border/glow appears on the current display.
3. Click underlying desktop apps while idle and confirm clicks pass through.
4. Press Control-Option-Space and confirm the bottom workspace sheet appears.
5. Press Escape and confirm the workspace sheet closes while the passive ambient layer remains.
6. Use the menu-bar "Open Ambient Overlay" fallback and confirm it opens the same sheet.
7. Disable Ambient Overlay and confirm all overlay windows close.
```

- [ ] **Step 6: Final verification and commit**

Run:

```bash
cd /Users/imackaartendrukkerij/.openclaw
git diff --check
cd /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos
swift test --filter AmbientOverlay
swift build
```

Expected: `git diff --check` prints no output, tests pass, build passes.

Commit:

```bash
git add /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Sources/OpenClaw/GeneralSettings.swift \
  /Users/imackaartendrukkerij/.openclaw/src/openclaw/apps/macos/Tests/OpenClawIPCTests/SettingsViewSmokeTests.swift
git commit -m "Add ambient overlay settings"
```

## Final Review Checklist

- [ ] Idle ambient panel uses `ignoresMouseEvents = true`.
- [ ] Armed workspace is a separate panel from the ambient panel.
- [ ] The menu-bar fallback works even if the global hotkey does not fire.
- [ ] Disabling the feature closes both ambient and workspace panels.
- [ ] Screen Recording and Accessibility are not required for the first slice.
- [ ] Existing Canvas behavior is unchanged.
- [ ] Existing right Option push-to-talk behavior is unchanged.
- [ ] The first slice does not add React, React Native, or WebKit.

## Self-Review Notes

- Spec coverage: this plan covers the first build slice from the design spec: passive current-display overlay, idle/armed state machine, global hotkey, menu fallback, native SwiftUI workspace sheet, settings, and tests. Annotation pins, all-displays window fan-out, and screen-aware suggestions remain later phases from the spec.
- Placeholder scan: no unfinished markers, dummy functions, or vague test instructions are used.
- Type consistency: `AmbientOverlayDisplayScope`, `AmbientOverlaySettings`, `AmbientOverlayExperienceController`, `AmbientOverlayDisplayController`, `AmbientOverlayHotkeyMatcher`, and the defaults keys are introduced before later tasks reference them.
