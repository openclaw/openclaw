import ClawdisKit
import Testing

@Suite struct CanvasCommandAliasTests {
    @Test func mapsKnownCanvasCommandsToScreen() {
        let mappings: [(ClawdisCanvasCommand, ClawdisScreenCommand)] = [
            (.show, .show),
            (.hide, .hide),
            (.setMode, .setMode),
            (.navigate, .navigate),
            (.evalJS, .evalJS),
            (.snapshot, .snapshot),
        ]

        for (canvas, screen) in mappings {
            #expect(
                ClawdisInvokeCommandAliases.canonicalizeCanvasToScreen(canvas.rawValue) ==
                    screen.rawValue)
        }
    }

    @Test func mapsUnknownCanvasNamespaceToScreen() {
        #expect(ClawdisInvokeCommandAliases.canonicalizeCanvasToScreen("canvas.foo") == "screen.foo")
    }

    @Test func leavesNonCanvasCommandsUnchanged() {
        #expect(
            ClawdisInvokeCommandAliases.canonicalizeCanvasToScreen(ClawdisCameraCommand.snap.rawValue) ==
                ClawdisCameraCommand.snap.rawValue)
    }

    @Test func capabilitiesUseStableStrings() {
        #expect(ClawdisCapability.canvas.rawValue == "canvas")
        #expect(ClawdisCapability.camera.rawValue == "camera")
        #expect(ClawdisCapability.voiceWake.rawValue == "voiceWake")
    }
}

