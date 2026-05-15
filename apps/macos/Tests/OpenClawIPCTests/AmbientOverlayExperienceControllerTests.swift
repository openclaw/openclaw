import Testing
@testable import OpenClaw

@MainActor
struct AmbientOverlayExperienceControllerTests {
    @Test func `disabled controller hides surfaces and stays idle`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)
        var closeCount = 0
        var hideCount = 0
        var ambientIntensities: [Double] = []
        controller.closeSurfaces = { closeCount += 1 }
        controller.hideWorkspace = { hideCount += 1 }
        controller.showAmbient = { ambientIntensities.append($0) }

        controller.setEnabled(false)
        controller.toggleArmed()

        #expect(controller.overlayState == .idle)
        #expect(controller.isEnabled == false)
        #expect(closeCount == 1)
        #expect(hideCount == 1)
        #expect(ambientIntensities.isEmpty)
        #expect(controller.showAmbient == nil)
        #expect(controller.showWorkspace == nil)
        #expect(controller.hideWorkspace == nil)
        #expect(controller.closeSurfaces == nil)
    }

    @Test func `enabled controller toggles armed state`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)
        var workspaceClose: (() -> Void)?
        var showWorkspaceCount = 0
        var hideCount = 0
        controller.showWorkspace = { close in
            showWorkspaceCount += 1
            workspaceClose = close
        }
        controller.hideWorkspace = { hideCount += 1 }

        controller.setEnabled(true)
        controller.toggleArmed()

        #expect(controller.overlayState == .armed)
        #expect(controller.isEnabled)
        #expect(showWorkspaceCount == 1)
        #expect(workspaceClose != nil)

        controller.toggleArmed()

        #expect(controller.overlayState == .idle)
        #expect(hideCount == 1)
    }

    @Test func `arming shows ambient before workspace after armed`() {
        let controller = AmbientOverlayExperienceController(enableUI: true)
        var events: [String] = []
        controller.showAmbient = { _ in events.append("ambient:\(controller.overlayState)") }
        controller.showWorkspace = { _ in events.append("workspace:\(controller.overlayState)") }

        controller.setEnabled(true)
        events.removeAll()
        controller.arm()

        #expect(events == ["ambient:arming", "workspace:armed"])
        #expect(controller.overlayState == .armed)
    }

    @Test func `enabled controller keeps hooks as observer callbacks during tests`() {
        let controller = AmbientOverlayExperienceController(enableUI: true)
        var events: [String] = []
        controller.showAmbient = { _ in events.append("ambient") }
        controller.showWorkspace = { close in
            events.append("workspace")
            close()
        }
        controller.hideWorkspace = { events.append("hide") }
        controller.closeSurfaces = { events.append("close") }

        controller.setEnabled(true)
        controller.arm()
        #expect(controller.hasDisplayControllerForTesting == false)
        controller.setEnabled(false)

        #expect(events == ["ambient", "ambient", "workspace", "hide", "hide", "close"])
        #expect(controller.showAmbient == nil)
        #expect(controller.showWorkspace == nil)
        #expect(controller.hideWorkspace == nil)
        #expect(controller.closeSurfaces == nil)
    }

    @Test func `escape dismiss returns to idle`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)
        var hideCount = 0
        controller.hideWorkspace = { hideCount += 1 }

        controller.setEnabled(true)
        controller.arm()
        controller.dismissInteractive(reason: .escape)

        #expect(controller.overlayState == .idle)
        #expect(hideCount == 1)
    }

    @Test func `escape key helper consumes escape only while armed`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)
        var hideCount = 0
        controller.hideWorkspace = { hideCount += 1 }

        controller.setEnabled(true)

        #expect(!controller.handleEscapeKeyDownForTesting(
            keyCode: AmbientOverlayEscapeMatcher.escapeKeyCode,
            modifierFlags: [],
            isRepeat: false))

        controller.arm()

        #expect(controller.handleEscapeKeyDownForTesting(
            keyCode: AmbientOverlayEscapeMatcher.escapeKeyCode,
            modifierFlags: [],
            isRepeat: false))
        #expect(controller.overlayState == .idle)
        #expect(hideCount == 1)
    }

    @Test func `escape key helper ignores repeats and non escape keys`() {
        let controller = AmbientOverlayExperienceController(enableUI: false)
        var hideCount = 0
        controller.hideWorkspace = { hideCount += 1 }

        controller.setEnabled(true)
        controller.arm()

        #expect(!controller.handleEscapeKeyDownForTesting(
            keyCode: AmbientOverlayEscapeMatcher.escapeKeyCode,
            modifierFlags: [],
            isRepeat: true))
        #expect(!controller.handleEscapeKeyDownForTesting(
            keyCode: 36,
            modifierFlags: [],
            isRepeat: false))
        #expect(controller.overlayState == .armed)
        #expect(hideCount == 0)
    }

    @Test func `settings update refreshes public settings snapshot`() {
        let controller = AmbientOverlayExperienceController(enableUI: true)
        var ambientIntensities: [Double] = []
        controller.showAmbient = { ambientIntensities.append($0) }
        let settings = AmbientOverlaySettings(
            isEnabled: true,
            displayScope: .allDisplays,
            intensity: 0.73,
            timeoutSeconds: 12)

        controller.applySettings(settings)

        #expect(controller.settings == settings)
        #expect(controller.isEnabled)
        #expect(ambientIntensities == [0.73, 0.73])
    }

    @Test func `settings update normalizes numeric values before applying`() {
        let controller = AmbientOverlayExperienceController(enableUI: true)
        var ambientIntensities: [Double] = []
        controller.showAmbient = { ambientIntensities.append($0) }

        controller.applySettings(AmbientOverlaySettings(
            isEnabled: true,
            displayScope: .currentDisplay,
            intensity: 2.5,
            timeoutSeconds: 1))

        #expect(controller.settings.intensity == 1.0)
        #expect(controller.settings.timeoutSeconds == 5.0)
        #expect(ambientIntensities == [1.0, 1.0])
    }
}
