import Testing
@testable import OpenClaw

struct GatewayAutostartPolicyTests {
    @Test(arguments: [
        (AppState.ConnectionMode.local, false, false, true),
        (.local, false, true, true),
        (.local, true, false, false),
        (.local, true, true, false),
        (.remote, false, false, false),
        (.remote, false, true, true),
        (.remote, true, false, false),
        (.remote, true, true, false),
        (.unconfigured, false, false, false),
        (.unconfigured, false, true, false),
        (.unconfigured, true, false, false),
        (.unconfigured, true, true, false),
    ])
    func `hosting and pause control local Gateway startup and persistence`(
        mode: AppState.ConnectionMode,
        paused: Bool,
        hostsLocalGateway: Bool,
        expected: Bool)
    {
        #expect(GatewayAutostartPolicy.shouldStartGateway(
            mode: mode,
            paused: paused,
            hostsLocalGateway: hostsLocalGateway) == expected)
        #expect(GatewayAutostartPolicy.shouldEnsureLaunchAgent(
            mode: mode,
            paused: paused,
            hostsLocalGateway: hostsLocalGateway) == expected)
    }
}
