import OpenClawChatUI
import OpenClawKit
import Testing
import UIKit
@testable import OpenClaw

struct ChatConnectionStatusTests {
    private func problem(
        _ kind: GatewayConnectionProblem.Kind,
        owner: GatewayConnectionProblem.Owner = .gateway,
        retryable: Bool = false,
        pauseReconnect: Bool = true) -> GatewayConnectionProblem
    {
        GatewayConnectionProblem(
            kind: kind,
            owner: owner,
            title: "Title",
            message: "Message",
            retryable: retryable,
            pauseReconnect: pauseReconnect)
    }

    private var unreachableProblem: GatewayConnectionProblem {
        self.problem(.connectionRefused, owner: .network, retryable: true, pauseReconnect: false)
    }

    private func input(
        _ state: GatewayDisplayState,
        problem: GatewayConnectionProblem? = nil,
        approvalFailed: Bool = false,
        firstSetup: Bool = false) -> ChatConnectionStatus.Input
    {
        ChatConnectionStatus.Input(
            state: state,
            problem: problem,
            approvalFailedUnreachable: approvalFailed,
            isFirstSetup: firstSetup)
    }

    @Test
    func `the strip never says connected and leaves first setup to its card`() {
        #expect(ChatConnectionStatus.resolve(self.input(.connected)) == nil)
        #expect(ChatConnectionStatus.resolve(self.input(.connected, approvalFailed: true)) == nil)
        #expect(ChatConnectionStatus.resolve(self.input(.disconnected, firstSetup: true)) == nil)
    }

    @Test
    func `each connection state maps to one strip row`() {
        #expect(ChatConnectionStatus.resolve(self.input(.connecting)) == .reconnecting)
        // A network failure the app keeps retrying on its own is still waiting.
        #expect(ChatConnectionStatus.resolve(self.input(.error, problem: self.unreachableProblem)) == .reconnecting)
        #expect(ChatConnectionStatus.resolve(self.input(.disconnected)) == .notConnected)
    }

    @Test
    func `sign-in, pairing and certificate problems show in the strip, other problems keep the banner`() {
        let token = self.problem(.gatewayAuthTokenMismatch)
        let pairing = self.problem(.pairingRequired)
        let certificate = self.problem(.tlsPinMismatch, owner: .network)
        #expect(ChatConnectionStatus.resolve(self.input(.error, problem: token)) == .signIn(token))
        #expect(ChatConnectionStatus.resolve(self.input(.error, problem: pairing)) == .pairing(pairing))
        #expect(ChatConnectionStatus.resolve(self.input(.error, problem: certificate)) == .certificate(certificate))
        #expect(ChatConnectionStatus.resolve(self.input(.error, problem: self.problem(.protocolMismatch))) == nil)
        #expect(ChatConnectionStatus.resolve(self.input(.error)) == nil)
    }

    @Test
    func `the top banner leaves out only what the chat's strip shows`() {
        let pairing = self.problem(.pairingRequired)
        #expect(ChatConnectionStatus.carries(pairing, chatState: .error))
        // The chat itself is connected, so its strip is empty: the banner keeps the problem.
        #expect(!ChatConnectionStatus.carries(pairing, chatState: .connected))
        #expect(ChatConnectionStatus.carries(self.unreachableProblem, chatState: .connecting))
        #expect(!ChatConnectionStatus.carries(self.problem(.protocolMismatch), chatState: .error))
    }

    @Test
    func `with Talk on, only a problem with a recovery shows, since Talk's row says Offline`() {
        var reconnecting = self.input(.connecting)
        reconnecting.isTalkActive = true
        var notConnected = self.input(.disconnected)
        notConnected.isTalkActive = true
        let pairing = self.problem(.pairingRequired)
        var rejected = self.input(.error, problem: pairing)
        rejected.isTalkActive = true
        #expect(ChatConnectionStatus.resolve(reconnecting) == nil)
        #expect(ChatConnectionStatus.resolve(notConnected) == .notConnected)
        #expect(ChatConnectionStatus.resolve(rejected) == .pairing(pairing))
    }

    @Test
    @MainActor
    func `no button while the app is still trying on its own, Try again once it stops`() {
        func action(_ status: ChatConnectionStatus) -> String? {
            status.strip(host: "Studio", waitBeforeShowing: .zero, recovery: nil) {}.action?.title
        }
        #expect(action(.reconnecting) == nil)
        #expect(action(.unreachable) == nil)
        #expect(action(.notConnected) == "Try again")
    }

    @Test
    @MainActor
    func `connection status labels omit periods and keep progress ellipses`() {
        func text(_ status: ChatConnectionStatus, first: Bool = false) -> String {
            status.strip(host: "Studio", waitBeforeShowing: .zero, isFirstConnect: first, recovery: nil) {}.text
        }
        #expect(text(.reconnecting, first: true) == "Connecting to Studio…")
        #expect(text(.reconnecting) == "Reconnecting to Studio…")
        #expect(text(.notConnected) == "Not connected to Studio")
        #expect(text(.unreachable) == "Can’t reach Studio")
        #expect(text(.signIn(self.problem(.gatewayAuthTokenMismatch))) == "Sign in to Studio again")
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        #expect(text(.pairing(self.problem(.pairingRequired))) == "Approve this \(device) on Studio")
        #expect(text(.certificate(self.problem(.tlsPinMismatch, owner: .network))) == "Verify Studio again")
        #expect(text(.certificate(self.problem(.tlsCertificateUntrusted, owner: .network))) == "Can’t verify Studio")
    }

    @Test
    @MainActor
    func `the strip names the banner's recovery short and never offers to reset onboarding`() {
        let recovery = GatewayProblemRecovery { _ in }
        let retry = OpenClawChatStatus.Action(title: "Try again") {}
        #expect(recovery.action(for: self.problem(.gatewayAuthTokenMismatch), retry: retry) == nil)
        #expect(recovery.action(for: self.problem(.pairingRequired), retry: retry)?.title == "Settings")
        #expect(recovery.action(for: self.unreachableProblem, retry: retry)?.title == "Try again")
    }

    @Test
    func `an approval that failed for lack of connection turns reconnecting into can't reach`() {
        #expect(ChatConnectionStatus.resolve(self.input(.connecting, approvalFailed: true)) == .unreachable)
    }

    @Test
    func `a host shows without its port, and a bare address reads OpenClaw`() {
        #expect(ChatConnectionStatus.displayHost("127.0.0.1:49940") == "OpenClaw")
        #expect(ChatConnectionStatus.displayHost("studio.local:18789") == "studio.local")
        #expect(ChatConnectionStatus.displayHost("[fd7a:115c::1]:18789") == "OpenClaw")
        #expect(ChatConnectionStatus.displayHost("fd7a:115c::1") == "OpenClaw")
        #expect(ChatConnectionStatus.displayHost("Studio") == "Studio")
    }
}
