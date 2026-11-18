import Testing
@testable import OpenClaw

@MainActor
struct PairingSSHTargetOwnershipTests {
    @Test func `direct gateway never uses the previous SSH gateway target`() {
        let settings = self.settings(transport: .direct, target: "operator@gateway-a.local:2222")
        let target = NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: settings,
            user: "operator")
        #expect(target == nil)
    }

    @Test func `active SSH transport keeps its configured host and checks the local user`() {
        let settings = self.settings(transport: .ssh, target: "operator@gateway-a.local:2222")
        #expect(NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: settings,
            user: "operator") == .init(host: "gateway-a.local", port: 2222))
        #expect(NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: settings,
            user: "other") == nil)
    }

    @Test(arguments: [AppState.ConnectionMode.local, .unconfigured])
    func `inactive SSH settings cannot authorize silent pairing`(mode: AppState.ConnectionMode) {
        #expect(NodePairingApprovalPrompter.silentPairingSSHTarget(
            settings: self.settings(mode: mode, transport: .ssh, target: "operator@gateway-a.local:2222"),
            user: "operator") == nil)
    }

    private func settings(
        mode: AppState.ConnectionMode = .remote,
        transport: AppState.RemoteTransport,
        target: String = "") -> CommandResolver.RemoteSettings
    {
        .init(
            mode: mode,
            transport: transport,
            target: target,
            identity: "",
            projectRoot: "",
            cliPath: "",
            sshHostKeyPolicy: .strict)
    }
}
