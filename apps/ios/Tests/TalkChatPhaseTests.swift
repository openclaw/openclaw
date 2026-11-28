import OpenClawChatUI
import Testing
@testable import OpenClaw

/// The phase the chat composer shows comes from the Talk owner, with issues reported where they happen.
@MainActor
struct TalkChatPhaseTests {
    @Test func `native Talk that starts listening reads as listening, not its raw status`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.updateGatewayConnected(true)
        manager.gatewayTalkConfigLoaded = true
        manager.isEnabled = true
        defer { manager.stop() }
        await manager.start()
        #expect(manager.chatPhase == .listening)
    }

    @Test func `starting offline is an issue the next status clears`() async {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.updateGatewayConnected(false)
        manager.isEnabled = true
        await manager.start()
        #expect(manager.chatPhase == .issue(.offline))
        manager.stop()
        #expect(manager.issue == nil)
        #expect(manager.chatPhase == .connecting)
    }

    @Test(arguments: TalkModeManager.ChatFixtureState.allCases)
    func `every fixture state maps to the phase the composer shows`(state: TalkModeManager.ChatFixtureState) {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        manager.enterChatFixture(state)
        manager.setEnabled(true)
        defer { manager.stop() }
        let expected: OpenClawChatTalkPhase = switch state {
        case .connecting: .connecting
        case .listening, .hearing, .muted: .listening
        case .thinking: .thinking
        case .speaking: .speaking
        case .microphoneOff: .issue(.microphoneAccess)
        case .offline: .issue(.offline)
        case .failed: .issue(.replyFailed)
        }
        #expect(manager.isEnabled)
        #expect(manager.chatPhase == expected)
        #expect(manager.isMicrophoneMuted == (state == .muted))
    }
}
