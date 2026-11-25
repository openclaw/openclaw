import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.testWaitLimit)
@MainActor
struct RootSidebarRosterLoadingTests {
    private struct Request: Decodable, Sendable {
        struct Params: Decodable, Sendable {
            let offset: Int
            let limit: Int
            let agentId: String
            let archived: Bool
        }

        let id: String
        let method: String
        let params: Params
    }

    private actor Requests {
        var values: [Request] = []

        func record(_ message: URLSessionWebSocketTask.Message) throws -> Request {
            let data: Data = switch message {
            case let .data(value): value
            case let .string(value): Data(value.utf8)
            @unknown default: throw URLError(.cannotParseResponse)
            }
            let request = try JSONDecoder().decode(Request.self, from: data)
            self.values.append(request)
            return request
        }
    }

    @Test func `roster owner decodes all wire pages without changing request scope`() async throws {
        try await self.withGateway(reply: { Self.page(offset: $0, total: 401) }) { appModel, requests in
            let roster = try await appModel.loadChatSessionRoster(limit: 200, archived: true)

            #expect(roster.sessions.count == 401)
            #expect(roster.sessions.first?.key == "agent:alpha:session-0")
            #expect(roster.sessions.last?.key == "agent:alpha:session-400")
            #expect(roster.totalCount == 401)
            #expect(roster.isComplete)
            #expect(!roster.isCached)
            let captured = await requests.values
            #expect(captured.map(\.params.offset) == [0, 200, 400])
            #expect(captured.allSatisfy {
                $0.method == "sessions.list" && $0.params.limit == 200 &&
                    $0.params.agentId == "alpha" && $0.params.archived
            })
        }
    }

    @Test(arguments: [0, 200])
    func `malformed wire page throws first or retains earlier decoded rows`(failedOffset: Int) async throws {
        try await self.withGateway(reply: { offset in
            offset == failedOffset ? #"{"sessions":false}"# : Self.page(offset: offset, total: 401)
        }) { appModel, requests in
            if failedOffset == 0 {
                await #expect(throws: DecodingError.self) {
                    try await appModel.loadChatSessionRoster(limit: 200, archived: true)
                }
                #expect(await requests.values.count == 1)
            } else {
                let roster = try await appModel.loadChatSessionRoster(limit: 200, archived: true)
                #expect(roster.sessions.count == 200)
                #expect(roster.sessions.last?.key == "agent:alpha:session-199")
                #expect(roster.totalCount == 401)
                #expect(!roster.isComplete)
                #expect(!roster.isCached)
                #expect(roster.incompleteLoadMessage != nil)
                #expect(await requests.values.count == 2)
            }
        }
    }

    private enum Interruption: CaseIterable, Sendable {
        case agent, gateway, connection, cancellation
    }

    @Test(arguments: Interruption.allCases)
    private func `retired or cancelled roster cannot publish a partial success`(interruption: Interruption) async throws {
        let secondPageRequested = AsyncTestGate()
        let releaseSecondPage = AsyncTestGate()
        try await self.withGateway(reply: { offset in
            if offset == 200 {
                secondPageRequested.open()
                await releaseSecondPage.wait()
            }
            return Self.page(offset: offset, total: 201)
        }) { appModel, requests in
            let task = Task { try await appModel.loadChatSessionRoster(limit: 200, archived: true) }
            defer {
                task.cancel()
                releaseSecondPage.open()
            }
            try await secondPageRequested.wait("second roster page request")
            switch interruption {
            case .agent: appModel.selectedAgentId = "beta"
            case .gateway: appModel.connectedGatewayID = "manual|other-roster-test|1"
            case .connection: await appModel.operatorSession.disconnect()
            case .cancellation: task.cancel()
            }
            releaseSecondPage.open()

            await #expect(throws: CancellationError.self) {
                try await TestWait.value(of: task, "interrupted roster load")
            }
            #expect(await requests.values.count == 2)
        }
    }

    private nonisolated static func page(offset: Int, total: Int) -> String {
        let end = min(offset + 200, total)
        let rows = (offset..<end).map {
            #"{"key":"agent:alpha:session-\#($0)","agentId":"alpha","label":"Session \#($0)","archived":true}"#
        }.joined(separator: ",")
        return #"{"sessions":[\#(rows)],"totalCount":\#(total),"nextOffset":\#(end),"hasMore":\#(end < total)}"#
    }

    private func withGateway(
        reply: @escaping @Sendable (Int) async -> String,
        run: @MainActor (NodeAppModel, Requests) async throws -> Void) async throws
    {
        let requests = Requests()
        let socketSession = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                guard GatewayWebSocketTestSupport.requestMethod(from: message) == "sessions.list" else {
                    let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                    socket.emitReceiveSuccess(.data(try JSONSerialization.data(withJSONObject: [
                        "type": "res", "id": id, "ok": true, "payload": [],
                    ])))
                    return
                }
                let request = try await requests.record(message)
                let payload = await reply(request.params.offset)
                socket.emitReceiveSuccess(.data(Data(
                    #"{"type":"res","id":"\#(request.id)","ok":true,"payload":\#(payload)}"#.utf8)))
            })
        })
        let appModel = NodeAppModel()
        appModel.connectedGatewayID = "manual|roster-test|1"
        appModel.gatewayDefaultAgentId = "alpha"
        appModel.selectedAgentId = "alpha"
        let gateway = appModel.operatorSession
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.allowStoredDeviceAuth = false
        options.deviceAuthGatewayID = appModel.connectedGatewayID
        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://roster-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: socketSession),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            appModel.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
            try #require(appModel.chatDeliveryAgentId == "alpha")
            try await run(appModel, requests)
            await gateway.disconnect()
        } catch {
            await gateway.disconnect()
            throw error
        }
    }
}
