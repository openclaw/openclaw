import Testing
@testable import OpenClaw

struct TalkProStateTests {
    @Test func `disabled talk without loaded config can start and retry load`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: false,
            statusText: "Offline",
            isConfigLoaded: false,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .unknown)

        #expect(state.title == "Voice config unavailable")
        #expect(state.primaryAction == .start)
        #expect(state.primaryButtonTitle == "Start Talk")
        #expect(state.waveformMode(micLevel: 0.8) == .still)
    }

    @Test func `enabled talk without loaded config can be stopped`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: true,
            statusText: "Offline",
            isConfigLoaded: false,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .unknown)

        #expect(state.title == "Voice config unavailable")
        #expect(state.primaryAction == .stop)
        #expect(state.primaryButtonTitle == "Stop Talk")
        #expect(state.waveformMode(micLevel: 0.8) == .still)
    }

    @Test func `enabled talk with loaded config can be stopped`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: true,
            statusText: "Ready",
            isConfigLoaded: true,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .ready)

        #expect(state.title == "Ready to talk")
        #expect(state.primaryAction == .stop)
    }

    @Test func `missing scope takes priority over unloaded config`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: false,
            isEnabled: false,
            statusText: "Offline",
            isConfigLoaded: false,
            isListening: false,
            isSpeaking: false,
            isUserSpeechDetected: false,
            permissionState: .missingScope("operator.talk.secrets"))

        #expect(state.title == "Gateway permission required")
        #expect(state.primaryAction == .enablePermission)
        #expect(state.primaryButtonTitle == "Enable Talk")
    }

    @Test func `demo mode keeps talk disabled`() {
        let state = TalkProState(
            gatewayConnected: true,
            isDemoMode: true,
            isEnabled: true,
            statusText: "Ready",
            isConfigLoaded: true,
            isListening: true,
            isSpeaking: true,
            isUserSpeechDetected: true,
            permissionState: .ready)

        #expect(state.title == "Demo mode only")
        #expect(state.primaryAction == .waiting)
        #expect(state.primaryButtonTitle == "Demo Mode Only")
        #expect(state.primaryButtonIcon == "lock.fill")
        #expect(state.waveformMode(micLevel: 0.8) == .still)
    }
}
