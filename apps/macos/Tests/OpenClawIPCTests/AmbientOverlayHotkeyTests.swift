import AppKit
import Testing
@testable import OpenClaw

struct AmbientOverlayHotkeyTests {
    @Test func `control option space matches`() {
        #expect(AmbientOverlayHotkeyMatcher.matches(keyCode: 49, modifierFlags: [.control, .option]))
    }

    @Test func `option space without control does not match`() {
        #expect(!AmbientOverlayHotkeyMatcher.matches(keyCode: 49, modifierFlags: [.option]))
    }

    @Test func `control option return does not match`() {
        #expect(!AmbientOverlayHotkeyMatcher.matches(keyCode: 36, modifierFlags: [.control, .option]))
    }

    @Test func `command and shift variants do not match`() {
        #expect(!AmbientOverlayHotkeyMatcher.matches(keyCode: 49, modifierFlags: [.control, .option, .command]))
        #expect(!AmbientOverlayHotkeyMatcher.matches(keyCode: 49, modifierFlags: [.control, .option, .shift]))
    }

    @Test func `repeat control option space is not handled`() {
        #expect(!AmbientOverlayHotkeyMatcher.shouldHandle(
            keyCode: 49,
            modifierFlags: [.control, .option],
            isRepeat: true))
    }
}
