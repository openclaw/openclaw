import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor DashboardReconnectAuthGate {
    private var token: String?

    func authToken() -> String? {
        self.token
    }

    func replaceToken(_ token: String) {
        self.token = token
    }
}

@Suite(.serialized)
@MainActor
struct DashboardReconnectTests {
    @Test func `authenticated control reconnect recovers unchanged ready route`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=route-a-device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "route-a-device-token",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let authGate = DashboardReconnectAuthGate()
        let socketURL = try #require(URL(string: "ws://127.0.0.1:60002"))
        let endpointState = GatewayEndpointState.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 2)
        let authentication = AsyncStream<GatewayConnection.ControlUIAuthenticationState>.makeStream(
            bufferingPolicy: .bufferingNewest(1))
        let manager = DashboardManager._testMake(
            controlUIAccessProvider: { _ in
                guard let token = await authGate.authToken() else { return nil }
                return .init(
                    authenticationState: .authenticated(routeGeneration: 1, socketGeneration: 2),
                    access: .token(token))
            },
            controlUIAuthenticationStream: { authentication.stream },
            endpointStateProvider: { endpointState },
            observeGatewayChanges: true,
            automaticGatewayProfileRefreshEnabled: false)
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        await manager.handleEndpointState(endpointState)
        let failureController = try #require(manager._testController())
        #expect(failureController !== controller)
        #expect(failureController.currentURL == URL(string: "about:blank"))

        await manager.handleEndpointState(endpointState)
        #expect(manager._testController() === failureController)

        await authGate.replaceToken("route-b-device-token")
        authentication.continuation.yield(.authenticated(routeGeneration: 1, socketGeneration: 2))
        try await AsyncTimeout.withTimeout(
            seconds: 1,
            onTimeout: { CancellationError() },
            operation: {
                while manager._testController() === failureController {
                    await Task.yield()
                }
            })

        let recoveredController = try #require(manager._testController())
        #expect(recoveredController !== failureController)
        #expect(!failureController.isWindowOpen)
        #expect(recoveredController.currentURL.absoluteString ==
            "http://127.0.0.1:60002/#token=route-b-device-token")
    }

    @Test func `authenticated credentialless route recovers dashboard`() async throws {
        let controller = DashboardWindowController(
            url: try #require(URL(string: "about:blank")),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        let socketURL = try #require(URL(string: "ws://127.0.0.1:60003"))
        let endpointState = GatewayEndpointState.ready(
            mode: .remote,
            url: socketURL,
            token: nil,
            password: nil,
            routeRevision: 3)
        let manager = DashboardManager._testMake(
            controlUIAccessProvider: { _ in
                .init(
                    authenticationState: .authenticated(routeGeneration: 1, socketGeneration: 1),
                    access: .noneRequired)
            },
            endpointStateProvider: { endpointState })
        manager._testSetController(controller)
        defer { manager._testController()?.closeDashboard() }

        await manager._testHandleControlUIAuthentication()

        let recovered = try #require(manager._testController())
        #expect(recovered !== controller)
        #expect(recovered.currentURL.absoluteString == "http://127.0.0.1:60003/")
        #expect(recovered.auth.isReady)
        let authScripts = recovered._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        #expect(authScripts[0].source.contains("gatewayUrl"))
        #expect(authScripts[0].source.contains("clearCredentials"))
        #expect(!authScripts[0].source.contains("\"token\""))
        #expect(!authScripts[0].source.contains("\"password\""))
    }
}
