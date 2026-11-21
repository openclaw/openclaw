import Foundation
import Observation
import OpenClawKit
import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
@Suite(.testWaitLimit)
struct RootSidebarLifecycleTests {
    @Test func foregroundAdmissionSurvivesInactivityButEndsInBackground() async throws {
        let requests = Requests()
        let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
            let data: Data
            switch message {
            case let .data(value): data = value
            case let .string(value): data = Data(value.utf8)
            @unknown default: return
            }
            let request = try JSONDecoder().decode(WireRequest.self, from: data)
            guard request.method != "connect" else { return }
            await requests.record(request)
            let payload: String = switch request.method {
            case "sessions.list":
                #"{"ts":0,"count":0,"totalCount":0,"hasMore":false,"defaults":{},"sessions":[]}"#
            case "cron.list": #"{"jobs":[]}"#
            case "agents.list": #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[]}"#
            case "chat.history": #"{"sessionKey":"main","sessionId":"synthetic","messages":[]}"#
            default: #"{"ok":true}"#
            }
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(
                id: request.id, payload: payload)))
        })
        let appModel = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let gateway = appModel.operatorSession
        let gatewayID = "sidebar-lifecycle-\(UUID().uuidString)"
        let url = try #require(URL(string: "ws://sidebar-lifecycle.invalid"))
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.deviceAuthGatewayID = gatewayID
        appModel.activeGatewayConnectConfig = GatewayConnectConfig(
            url: url, stableID: gatewayID, tls: nil, token: nil, bootstrapToken: nil, password: nil,
            nodeOptions: options)
        appModel.gatewayDefaultAgentId = "main"
        try await gateway.connect(
            url: url, credentials: .init(token: nil), connectOptions: options,
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
            onConnected: {}, onDisconnected: { _ in },
            onInvoke: { .init(id: $0.id, ok: true) })
        appModel.apply(.connected(GatewaySessionInfo(serverName: "Synthetic Gateway")), to: .node, route: nil)
        appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
        let scene = Scene()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let host = UIHostingController(rootView: Host(
            scene: scene, appModel: appModel, controller: controller, appearance: AppAppearanceModel()))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            appModel.apply(.dropped, to: .operator, route: nil)
        }
        do {
            await Self.render(host)
            #expect(requests.loads.isEmpty, "Initial inactive is not foreground admission")
            scene.phase = .active
            try await TestWait.observed("first active sidebar load") {
                requests.loads.count == 4 && requests.visibility.last == true
            }
            let initial = requests.loads
            for _ in 0..<3 {
                scene.phase = .inactive
                try await TestWait.observed("inactive observer hidden") { requests.visibility.last == false }
                await Self.render(host)
                #expect(requests.loads == initial)
                scene.phase = .active
                try await TestWait.observed("active observer visible") { requests.visibility.last == true }
                await Self.render(host)
                try #require(requests.loads == initial, "Transient inactivity must not restart shared tasks")
            }

            // A retained subscription must still consume events while inactive; merely
            // cancelling without re-subscribing would pass a zero-reload assertion.
            scene.phase = .inactive
            try await TestWait.observed("observer hidden before sequence gap") { requests.visibility.last == false }
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: "seqGap", seq: 1)))
            try await TestWait.observed("inactive subscription consumes sequence gap") {
                requests.loads["sessions.list", default: 0] > initial["sessions.list", default: 0]
            }
            #expect(requests.visibility.last == false)
            let repaired = requests.loads
            scene.phase = .background
            await Self.render(host)
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: "seqGap", seq: 2)))
            await Self.render(host)
            #expect(requests.loads == repaired, "Background must cancel the event consumer")
            scene.phase = .inactive
            await Self.render(host)
            #expect(requests.loads == repaired, "Background-to-inactive must not reopen shared tasks")
            scene.phase = .active
            try await TestWait.observed("foreground restarts shared work") {
                repaired.allSatisfy { method, count in requests.loads[method, default: 0] > count } &&
                    requests.visibility.last == true
            }
        } catch {
            await gateway.disconnect()
            throw error
        }
        await gateway.disconnect()
    }

    private static func render(_ host: UIViewController) async {
        // Flush SwiftUI observation/layout and scheduled MainActor work, not a wall-clock delay.
        for _ in 0..<20 {
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            await Task.yield()
        }
    }

    @MainActor
    @Observable
    private final class Scene {
        var phase: ScenePhase = .inactive
    }

    private struct Host: View {
        let scene: Scene
        let appModel: NodeAppModel
        let controller: GatewayConnectionController
        let appearance: AppAppearanceModel

        var body: some View {
            RootTabs(initialSidebarVisibility: true)
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.controller)
                .environment(self.appearance)
                .environment(\.scenePhase, self.scene.phase)
        }
    }

    @MainActor
    @Observable
    private final class Requests {
        var loads: [String: Int] = [:]
        var visibility: [Bool] = []

        func record(_ request: WireRequest) {
            if request.method == "sessions.list", request.params?.limit == 200 {
                self.loads[request.method, default: 0] += 1
            } else if ["usage.cost", "cron.list", "sessions.subscribe"].contains(request.method) {
                self.loads[request.method, default: 0] += 1
            } else if request.method == "sessions.observer.visibility", let visible = request.params?.visible {
                self.visibility.append(visible)
            }
        }
    }
}

private struct WireRequest: Decodable, Sendable {
    struct Params: Decodable, Sendable {
        let limit: Int?
        let visible: Bool?
    }

    let id: String
    let method: String
    let params: Params?
}
