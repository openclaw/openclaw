import Foundation
import Observation
import OpenClawProtocol
import SQLite3
import Testing
import XCTest
@testable import OpenClawKit
@testable import OpenClawWatchApp

@MainActor
@Suite(.serialized)
struct WatchGatewayControllerTests {
    @Test(arguments: [1, 2])
    func `disconnect joins unclaimed cleanup after synchronous suspension`(_ repetitions: Int) async throws {
        try await Self.withConnectedConversations { _, conversations, fixture in
            for _ in 0..<repetitions {
                conversations.suspend()
            }
            await conversations.disconnect(clear: true)
            // No fixture wait may start or join the suspended cleanup before this assertion.
            #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
            #expect(!conversations.connected)
            #expect(conversations.route == nil)
        }
    }

    @Test func `disconnect joins unexpected closure without changing its presentation`() async throws {
        try await Self.withConnectedConversations { controller, conversations, fixture in
            let poll = try await fixture.next("idle poll before external closure")
            try #require(poll.request.url?.lastPathComponent == "poll")
            let closed = XCTestExpectation(description: "The owner presents the external closure")
            withObservationTracking {
                _ = conversations.status
            } onChange: {
                closed.fulfill()
            }
            try poll.respond(status: 409, body: JSONSerialization.data(withJSONObject: [
                "error": ["code": "ingress_changed", "message": "Ingress changed", "resyncRequired": true],
            ]))
            let result = await XCTWaiter.fulfillment(of: [closed], timeout: 3)
            try #require(result == .completed)
            #expect(!conversations.connected)
            let status = conversations.status
            await conversations.disconnect(clear: false)
            #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
            #expect(conversations.status == status)
            #expect(!controller.recoveryRequired)
        }
    }

    @Test func `resume claims suspended cleanup before admitting another connection`() async throws {
        var admissionDeletes: [Int] = []
        try await Self.withConnectedConversations(
            onAdmission: { fixture in
                admissionDeletes.append(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count)
            },
            operation: { controller, conversations, fixture in
                let consumer = GatewayOperatorHTTPGate()
                defer { consumer.release() }
                let read = Task {
                    try await fixture.session.request(method: "chat.history") { _, _ in await consumer.wait() }
                }
                var resuming: Task<Void, Never>?
                do {
                    try await Self.reply(
                        fixture,
                        method: "chat.history",
                        sequence: 4,
                        cursor: 4,
                        payload: AnyCodable(["messages": [String]()]))
                    try await consumer.waitUntilEntered()
                    conversations.suspend()
                    conversations.suspend()
                    conversations.resume()
                    resuming = Task {
                        guard !Task.isCancelled else { return }
                        await conversations.refresh()
                    }
                    let deletion = try await fixture.next("resume cleanup DELETE")
                    try #require(deletion.request.httpMethod == "DELETE")
                    #expect(admissionDeletes == [0])
                    consumer.release()
                    try await Self.finishConnection(conversations, fixture: fixture)
                    await resuming?.value
                    await #expect(throws: GatewayOperatorHTTPError.self) { try await read.value }
                    #expect(admissionDeletes == [0, 1])
                    #expect(conversations.connected)
                    try Self.requireOperatorSetup(controller, fixture: fixture)
                } catch {
                    consumer.release()
                    read.cancel()
                    resuming?.cancel()
                    await conversations.disconnect(clear: true)
                    _ = try? await read.value
                    await resuming?.value
                    throw error
                }
            })
    }

    @Test func `approved upgrade commits its grant before acknowledgement and reconnects after cleanup`() async throws {
        let scopes = ["operator.approvals", "operator.read", "operator.talk", "operator.write"]
        let token = "upgraded-operator-fixture"
        var admissionDeletes: [Int] = []
        try await Self.withConnectedConversations(
            onAdmission: { fixture in
                admissionDeletes.append(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count)
            },
            operation: { controller, conversations, fixture in
                let configuration = try #require(controller.configuration)
                let upgrade = Task { await conversations.requestUpgrade() }
                do {
                    let request = try await Self.nextFrame(fixture, method: "device.scopes.requestUpgrade")
                    #expect(try request.frame.params?.dictionaryValue?["scopes"]?.arrayValue?
                        .compactMap(\.stringValue) == scopes)
                    request.accept(4)
                    let registration = try await fixture.next("upgrade registration poll")
                    try #require(registration.request.url?.lastPathComponent == "poll")
                    try registration.respond(body: GatewayOperatorHTTPFixture.delivery(
                        requestID: request.frame.id,
                        payload: AnyCodable(["requestId": "upgrade-one"]),
                        cursor: 4,
                        accepted: 4))
                    let wait = try await Self.nextFrame(fixture, method: "device.scopes.waitUpgrade")
                    #expect(try wait.frame.params?.dictionaryValue?["requestId"]?.stringValue == "upgrade-one")
                    wait.accept(5)
                    let result = try await fixture.next("approved upgrade result poll")
                    try #require(result.request.url?.lastPathComponent == "poll")
                    let committed = XCTestExpectation(description: "Upgrade consumer durably installs the grant")
                    // This presentation change occurs inside the real RPC consumer,
                    // after storage but before it returns authority to the HTTP actor.
                    withObservationTracking {
                        _ = conversations.status
                    } onChange: {
                        MainActor.assumeIsolated {
                            let grant = DeviceAuthStore.loadToken(
                                deviceId: fixture.identity.deviceId,
                                role: "operator",
                                gatewayID: configuration.gatewayID,
                                profile: .primary)
                            #expect(grant?.token == token)
                            #expect(Set(grant?.scopes ?? []) == Set(scopes))
                            for exchange in fixture.snapshot where exchange.request.httpMethod == "POST" {
                                #expect(((try? exchange.object["ack"] as? Int) ?? 0) < 5)
                            }
                            committed.fulfill()
                        }
                    }
                    try result.respond(body: GatewayOperatorHTTPFixture.delivery(
                        requestID: wait.frame.id,
                        payload: AnyCodable([
                            "status": "approved", "requestId": "upgrade-one", "deviceToken": token, "scopes": scopes,
                        ]),
                        cursor: 5,
                        accepted: 5))
                    let commitResult = await XCTWaiter.fulfillment(of: [committed], timeout: 3)
                    try #require(commitResult == .completed)
                    try await Self.finishConnection(conversations, fixture: fixture, scopes: scopes, token: token)
                    await upgrade.value
                    #expect(admissionDeletes == [0, 1])
                    #expect(conversations.canWrite && conversations.canApprove)
                    #expect(!controller.recoveryRequired)
                    let grant = DeviceAuthStore.loadToken(
                        deviceId: fixture.identity.deviceId,
                        role: "operator",
                        gatewayID: configuration.gatewayID,
                        profile: .primary)
                    #expect(grant?.token == token)
                    #expect(Set(grant?.scopes ?? []) == Set(scopes))
                } catch {
                    upgrade.cancel()
                    await conversations.disconnect(clear: true)
                    await upgrade.value
                    throw error
                }
            })
    }

    @Test func `ordinary RPC failure after hello joins the operator connection cleanup`() async throws {
        try await Self.withUnconfiguredWatch { controller, _ in
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            let configuration = try #require(controller.configuration, "Direct setup: \(controller.statusText)")
            let fixture = try await WatchGatewayOperatorHTTPFixture.start(gatewayID: configuration.gatewayID)
            do {
                let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                    #"{"sessionToken":"node-session","deviceToken":"node-fixture"}"#.utf8))
                try await controller.acceptNodeHandshake(
                    response, configuration: configuration, identity: fixture.identity, usedBootstrap: false)
                try Self.requireOperatorSetup(controller, fixture: fixture)
                controller.setEnabled(false)
                controller.connectForForeground()
                controller.setEnabled(true)
                // Retire the subordinate node before its queued startup; this test owns only operator HTTP.
                controller.node.disconnectForBackground()
                let conversations = WatchDirectConversations(gateway: controller) { _, _ in fixture.session }
                conversations.appear()
                let refresh = Task { await conversations.refresh() }
                let repeatedRefresh = Task { await conversations.refresh() }
                let begin = try await fixture.next("begin")
                #expect(begin.request.url?.lastPathComponent == "connections")
                try begin.respond(status: 201, body: GatewayOperatorHTTPFixture.beginBody())
                let connect = try await fixture.next("connect frame")
                #expect(try connect.frame.method == "connect")
                connect.accept(1)
                let hello = try await fixture.next("hello poll")
                try hello.respond(body: GatewayOperatorHTTPFixture.hello(requestID: connect.frame.id))
                var request = try await fixture.next("agents.list frame or idle poll")
                if request.request.url?.lastPathComponent == "poll" {
                    request = try await fixture.next("agents.list frame")
                }
                #expect(try request.frame.method == "agents.list")
                request.accept(2)
                let poll = try await fixture.next("agents.list result poll")
                try poll.respond(body: JSONSerialization.data(withJSONObject: [
                    "acceptedClientSeq": 2,
                    "frames": [[
                        "cursor": 2,
                        "frame": [
                            "type": "res", "id": request.frame.id, "ok": false,
                            "error": ["code": "UNAVAILABLE", "message": "Agents unavailable"],
                        ],
                    ]],
                ]))
                await refresh.value
                await repeatedRefresh.value
                #expect(!conversations.connected)
                #expect(conversations.status == "Agents unavailable")
                #expect(!controller.recoveryRequired)
                #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
                #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "connections" }.count == 1)
            } catch {
                await fixture.stop()
                throw error
            }
            await fixture.stop()
        }
    }

    @Test(arguments: ["disabled", "background", "hidden"])
    func `disabled background and hidden refresh never create an operator transport`(_ state: String) async throws {
        try await Self.withUnconfiguredWatch { controller, _ in
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            let configuration = try #require(controller.configuration, "Direct setup: \(controller.statusText)")
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
            let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"""
                {"sessionToken":"node-session","deviceToken":"node-fixture","deviceTokens":[
                  {"role":"operator","deviceToken":"operator-fixture","scopes":["operator.read","operator.talk"]}
                ]}
                """#.utf8))
            try await controller.acceptNodeHandshake(
                response, configuration: configuration, identity: identity, usedBootstrap: true)
            if state != "background" {
                controller.setEnabled(false)
                controller.connectForForeground()
                if state == "hidden" {
                    controller.setEnabled(true)
                    controller.node.disconnectForBackground()
                }
            }
            #expect(controller.isForeground == (state != "background"))
            #expect(controller.isEnabled == (state != "disabled"))
            #expect(!controller.setupIncomplete)
            var attempts = 0
            let conversations = WatchDirectConversations(gateway: controller) { _, _ in
                attempts += 1
                throw GatewayOperatorHTTPError.invalidContract
            }
            if state != "hidden" { conversations.appear() }
            let status = conversations.status
            await conversations.refresh()
            #expect(attempts == 0)
            #expect(conversations.status == status)
            #expect(!conversations.connected)
            #expect(!controller.recoveryRequired)
        }
    }

    @Test(arguments: ["agent", "session"])
    func `selection suspended at unsubscribe cannot restore IDs after setup replacement`(_ kind: String) async throws {
        try await Self.withConnectedConversations { controller, conversations, fixture in
            let first = try #require(conversations.sessions.first)
            let initialSelection = Task { await conversations.selectSession(first) }
            try await Self.reply(
                fixture, method: "sessions.messages.subscribe", sequence: 4, cursor: 4,
                payload: AnyCodable(["subscribed": true, "key": first.key]))
            try await Self.reply(
                fixture, method: "chat.history", sequence: 5, cursor: 5,
                payload: AnyCodable(["messages": [String]()]))
            await initialSelection.value
            #expect(conversations.route?.sessionKey == first.key)
            let second = try #require(conversations.sessions.last)
            let selection = Task {
                if kind == "agent" {
                    await conversations.selectAgent("second-agent")
                } else {
                    await conversations.selectSession(second)
                }
            }
            let unsubscribe = try await Self.nextFrame(fixture, method: "sessions.messages.unsubscribe")
            unsubscribe.accept(6)
            let poll = try await fixture.next("unsubscribe result poll")
            #expect(poll.request.url?.lastPathComponent == "poll")
            try await Self.replaceSetup(controller)
            await selection.value
            #expect(conversations.route == nil)
            #expect(conversations.selectedAgentID == nil)
            #expect(conversations.sessions.isEmpty)
            #expect(!controller.recoveryRequired)
            #expect(fixture.snapshot.filter { $0.request.httpMethod == "DELETE" }.count == 1)
        }
    }

    @Test(arguments: ["create", "upgrade", "refresh", "send"])
    func `retired operations cannot overwrite replacement setup presentation or require recovery`(_ kind: String)
        async throws
    {
        let scopes = kind == "upgrade" ? GatewayOperatorHTTPFixture.scopes
            : ["operator.read", "operator.talk", "operator.write", "operator.approvals"]
        try await Self.withConnectedConversations(scopes: scopes) { controller, conversations, fixture in
            var sequence = 4
            if kind == "send" {
                let session = try #require(conversations.sessions.first)
                let selecting = Task { await conversations.selectSession(session) }
                try await Self.reply(
                    fixture, method: "sessions.messages.subscribe", sequence: sequence, cursor: sequence,
                    payload: AnyCodable(["subscribed": true, "key": session.key]))
                sequence += 1
                try await Self.reply(
                    fixture, method: "chat.history", sequence: sequence, cursor: sequence,
                    payload: AnyCodable(["messages": [String]()]))
                sequence += 1
                await selecting.value
            }
            let route = conversations.route
            let operation = Task {
                switch kind {
                case "create": await conversations.createSession()
                case "upgrade": await conversations.requestUpgrade()
                case "send":
                    if let route { await conversations.send("one message", route: route) }
                default: await conversations.refresh()
                }
            }
            if kind == "upgrade" {
                try await Self.reply(
                    fixture, method: "device.scopes.requestUpgrade", sequence: sequence, cursor: sequence,
                    payload: AnyCodable(["requestId": "upgrade-one"]))
                sequence += 1
            }
            let method = switch kind {
            case "create": "sessions.create"
            case "upgrade": "device.scopes.waitUpgrade"
            case "send": "chat.send"
            default: "sessions.list"
            }
            let held = try await Self.nextFrame(fixture, method: method)
            held.accept(sequence)
            let poll = try await fixture.next("\(method) held result poll")
            #expect(poll.request.url?.lastPathComponent == "poll")
            if kind == "send" {
                controller.disconnectForBackground()
                #expect(conversations.deliveryStatus?.contains("uncertain") == true)
            }
            try await Self.replaceSetup(controller)
            let status = conversations.status
            await operation.value
            #expect(conversations.status == status)
            #expect(conversations.deliveryStatus == nil)
            #expect(conversations.route == nil)
            #expect(!conversations.busy)
            #expect(!conversations.upgrading)
            #expect(!controller.recoveryRequired)
            #expect(fixture.snapshot.filter { $0.request.url?.lastPathComponent == "connections" }.count == 1)
        }
    }

    @Test(arguments: ["configure", "forget"])
    func `setup teardown blocks refresh and cannot end a newer voice presentation`(_ kind: String) async throws {
        try await Self.withConnectedConversations { controller, _, fixture in
            let stamp = try #require(controller.configuration?.setupSentAtMs)
            let consumer = GatewayOperatorHTTPGate()
            defer { consumer.release() }
            let read = Task {
                try await fixture.session.request(method: "chat.history") { _, _ in await consumer.wait() }
            }
            try await Self.reply(
                fixture, method: "chat.history", sequence: 4, cursor: 4,
                payload: AnyCodable(["messages": [String]()]))
            try await consumer.waitUntilEntered()
            let obsolete = Task {
                if kind == "configure" {
                    await controller.configure(
                        setupCode: #"{"url":"wss://gateway.example.invalid/older","bootstrapToken":"older-setup"}"#,
                        sentAtMs: stamp + 1)
                } else {
                    await controller.forget()
                }
            }
            let deletion = try await fixture.next("setup teardown DELETE")
            try #require(deletion.request.httpMethod == "DELETE")
            let installed = try #require(controller.configuration, "Direct setup: \(controller.statusText)")
            #expect(controller.isEnabled && controller.isForeground)
            #expect(!controller.setupIncomplete && !controller.recoveryRequired)
            #expect(!controller.isInstalled(installed))
            var attempts = 0
            let refresh = WatchDirectConversations(gateway: controller) { _, _ in
                attempts += 1
                throw GatewayOperatorHTTPError.invalidContract
            }
            refresh.appear()
            await refresh.refresh()
            #expect(attempts == 0)
            refresh.disappear()
            // The first teardown is joining an awaited old consumer. The newer setup has no such session.
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/newer","bootstrapToken":"newer-setup"}"#,
                sentAtMs: stamp + 2)
            controller.node.disconnectForBackground()
            let voice = try #require(controller.configuration?.voiceConnection)
            // A rejected new start changes the real voice owner's presentation without opening audio or sockets.
            controller.voiceCall.start(connection: voice, isCurrent: { false })
            #expect(controller.voiceCall.state == .failed)
            consumer.release()
            await obsolete.value
            await #expect(throws: GatewayOperatorHTTPError.self) { try await read.value }
            #expect(controller.configuration?.setupSentAtMs == stamp + 2)
            #expect(controller.voiceCall.state == .failed)
        }
    }

    @Test(arguments: ["rejected", "uncertain", "created"])
    func `creating the first conversation records an outcome without an existing route`(_ outcome: String)
        async throws
    {
        try await Self.withConnectedConversations(
            scopes: ["operator.read", "operator.talk", "operator.write", "operator.approvals"])
        { _, conversations, fixture in
            #expect(conversations.route == nil)
            let create = Task { await conversations.createSession() }
            let request = try await Self.nextFrame(fixture, method: "sessions.create")
            #expect(conversations.deliveryStatus == "Creating conversation...")
            request.accept(4)
            let poll = try await fixture.next("sessions.create result poll")
            if outcome == "uncertain" {
                try poll.respond(status: 409, body: JSONSerialization.data(withJSONObject: [
                    "error": ["code": "ingress_changed", "message": "Ingress changed", "resyncRequired": true],
                ]))
            } else if outcome == "rejected" {
                try poll.respond(body: JSONSerialization.data(withJSONObject: [
                    "acceptedClientSeq": 4,
                    "frames": [[
                        "cursor": 4,
                        "frame": [
                            "type": "res", "id": request.frame.id, "ok": false,
                            "error": ["code": "UNAVAILABLE", "message": "Conversation could not be created"],
                        ],
                    ]],
                ]))
            } else {
                try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
                    requestID: request.frame.id,
                    payload: AnyCodable(["ok": true, "key": "new-session"]),
                    cursor: 4, accepted: 4))
                // A concurrent list update can omit the new session; success must still be visible.
                try await Self.reply(
                    fixture, method: "sessions.list", sequence: 5, cursor: 5,
                    payload: AnyCodable(["sessions": [String]()]))
            }
            await create.value
            #expect(!conversations.busy)
            #expect(conversations.route == nil)
            let status = try #require(conversations.deliveryStatus)
            if outcome == "rejected" {
                #expect(status == "Conversation could not be created")
            } else if outcome == "created" {
                #expect(status == "Conversation created")
            } else {
                #expect(status.contains("unknown") || status.contains("uncertain"))
                #expect(!conversations.connected)
            }
            let creates = try fixture.snapshot.filter { exchange in
                guard exchange.request.url?.lastPathComponent == "frames" else { return false }
                return try exchange.frame.method == "sessions.create"
            }
            #expect(creates.count == 1)
        }
    }

    @Test func `operator write failure preserves redeemed node and leaves fallback setup incomplete`() async throws {
        try await Self.withUnconfiguredWatch { controller, stateDirectory in
            let sentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: sentAtMs)
            let configuration = try #require(controller.configuration, "Direct setup: \(controller.statusText)")
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId, role: "node", token: "previous-node",
                gatewayID: configuration.gatewayID, profile: .primary))

            let databaseURL = stateDirectory.appendingPathComponent("state/openclaw.sqlite")
            // The native owner already created both canonical tables and indexes.
            // Match DeviceIdentityStoreTests' versioned global database fixture:
            // a foreign trigger is deliberately forbidden in a native v0 store.
            try Self.execute(databaseURL, """
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              agent_id TEXT,
              app_version TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_meta (
              meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
            ) VALUES ('primary', 'global', 4, NULL, NULL, 1800000000000, 1800000000000);
            PRAGMA user_version = 4;
            """)
            // Fail only the second durable handoff, using the real store's write boundary.
            try Self.execute(databaseURL, """
            CREATE TRIGGER reject_operator_grant BEFORE INSERT ON device_auth_tokens
            WHEN NEW.token = 'rejected-operator'
            BEGIN SELECT RAISE(ABORT, 'simulated operator write failure'); END;
            """)
            try #require(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "node",
                token: "node-write-control",
                gatewayID: configuration.gatewayID,
                profile: .primary))
            try #require(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId,
                role: "node",
                gatewayID: configuration.gatewayID,
                profile: .primary)?.token == "node-write-control")
            try #require(!DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "operator",
                token: "rejected-operator",
                scopes: GatewayOperatorHTTPFixture.scopes,
                gatewayID: configuration.gatewayID,
                profile: .primary))
            let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"""
                {"sessionToken":"node-session","deviceToken":"redeemed-node","deviceTokens":[
                  {"role":"operator","deviceToken":"rejected-operator",
                   "scopes":["operator.read","operator.talk"]}
                ]}
                """#.utf8))
            do {
                try await controller.acceptNodeHandshake(
                    response, configuration: configuration, identity: identity, usedBootstrap: true)
                Issue.record("Failed operator write completed setup")
            } catch GatewayOperatorHTTPError.pairingRequired {}

            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "node",
                gatewayID: configuration.gatewayID, profile: .primary)?.token == "redeemed-node")
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator",
                gatewayID: configuration.gatewayID, profile: .primary) == nil)
            #expect(controller.configuration?.link.bootstrapToken == "one-time-setup")
            #expect(controller.recoveryRequired)
            #expect(controller.voiceConnection == nil)

            // This is the response after the consumed bootstrap gets 401 and the node token reconnects.
            let fallback = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"{"sessionToken":"fallback-session","deviceToken":"redeemed-node"}"#.utf8))
            try await controller.acceptNodeHandshake(
                fallback, configuration: configuration, identity: identity, usedBootstrap: false)
            #expect(controller.configuration?.link.bootstrapToken == nil)
            #expect(controller.setupIncomplete)
            #expect(controller.recoveryRequired)
            #expect(controller.voiceConnection == nil)
        }
    }

    @Test func `fresh setup clears operator authority and rejects older handoffs without touching phone tokens`()
        async throws
    {
        try await Self.withUnconfiguredWatch { controller, _ in
            let code = #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#
            let sentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            await controller.configure(setupCode: code, sentAtMs: sentAtMs)
            let original = try #require(controller.configuration, "Direct setup: \(controller.statusText)")
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
            for gatewayID in [original.gatewayID, "phone-snapshot-gateway"] {
                #expect(DeviceAuthStore.storeTokenPersisted(
                    deviceId: identity.deviceId, role: "operator", token: "existing-operator",
                    scopes: ["operator.read", "operator.talk", "operator.write", "operator.approvals"],
                    gatewayID: gatewayID, profile: .primary))
            }
            await controller.configure(setupCode: code, sentAtMs: sentAtMs + 1)
            #expect(controller.configuration?.setupSentAtMs == sentAtMs + 1)
            #expect(controller.storedOperatorScopes().isEmpty)
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "operator",
                gatewayID: "phone-snapshot-gateway", profile: .primary)?.token == "existing-operator")
            await controller.configure(setupCode: code, sentAtMs: sentAtMs)
            #expect(controller.configuration?.setupSentAtMs == sentAtMs + 1)

            let obsolete = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                #"{"sessionToken":"old-session","deviceToken":"obsolete-node"}"#.utf8))
            do {
                try await controller.acceptNodeHandshake(
                    obsolete, configuration: original, identity: identity, usedBootstrap: true)
                Issue.record("An obsolete handoff changed the replacement setup")
            } catch is CancellationError {}
            #expect(DeviceAuthStore.loadToken(
                deviceId: identity.deviceId, role: "node",
                gatewayID: original.gatewayID, profile: .primary) == nil)
        }
    }

    private static func withUnconfiguredWatch(
        operation: @MainActor (WatchGatewayController, URL) async throws -> Void) async throws
    {
        let service = "ai.openclaw.watch.direct-node"
        let account = "gateway"
        // Run on a clean test Watch. Never replace an installed user's Keychain setup.
        try #require(GenericPasswordKeychainStore.loadString(service: service, account: account) == nil)
        let defaults = UserDefaults.standard
        let keys = ["watch.directNode.enabled", "watch.directNode.lastSetupSentAtMs"]
        let savedDefaults = keys.map { defaults.object(forKey: $0) }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("watch-gateway-\(UUID().uuidString)", isDirectory: true)
        defer {
            _ = GenericPasswordKeychainStore.delete(service: service, account: account)
            for (key, value) in zip(keys, savedDefaults) {
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
            try? FileManager.default.removeItem(at: directory)
        }
        for key in keys {
            defaults.removeObject(forKey: key)
        }
        try await DeviceIdentityStore.withStateDirectory(directory) {
            _ = try DeviceIdentityStore.loadOrCreatePersistedOrThrow(profile: .primary)
            do {
                let probeAccount = "prerequisite-\(UUID().uuidString)"
                let probeValue = "watch-keychain-prerequisite"
                defer {
                    if case let .failure(error) = GenericPasswordKeychainStore.deleteResult(
                        service: service, account: probeAccount)
                    {
                        Issue.record(error)
                    }
                }
                try GenericPasswordKeychainStore.saveStringResult(
                    probeValue, service: service, account: probeAccount).get()
                try #require(
                    GenericPasswordKeychainStore.loadString(service: service, account: probeAccount) == probeValue,
                    "Watch Keychain prerequisite did not round-trip")
            }
            let controller = WatchGatewayController()
            do {
                try await operation(controller, directory)
            } catch {
                await controller.forget()
                throw error
            }
            await controller.forget()
        }
    }

    private static func withConnectedConversations(
        scopes: [String] = GatewayOperatorHTTPFixture.scopes,
        onAdmission: @escaping @MainActor (WatchGatewayOperatorHTTPFixture) -> Void = { _ in },
        operation: @MainActor (WatchGatewayController, WatchDirectConversations, WatchGatewayOperatorHTTPFixture)
        async throws -> Void) async throws
    {
        try await self.withUnconfiguredWatch { controller, _ in
            await controller.configure(
                setupCode: #"{"url":"wss://gateway.example.invalid/team","bootstrapToken":"one-time-setup"}"#,
                sentAtMs: Int64(Date().timeIntervalSince1970 * 1000))
            let configuration = try #require(controller.configuration, "Direct setup: \(controller.statusText)")
            let fixture = try await WatchGatewayOperatorHTTPFixture.start(
                gatewayID: configuration.gatewayID, scopes: scopes)
            do {
                let response = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
                    #"{"sessionToken":"node-session","deviceToken":"node-fixture"}"#.utf8))
                try await controller.acceptNodeHandshake(
                    response, configuration: configuration, identity: fixture.identity, usedBootstrap: false)
                try Self.requireOperatorSetup(controller, fixture: fixture, scopes: scopes)
                let conversations = WatchDirectConversations(gateway: controller) { _, _ in
                    onAdmission(fixture)
                    return fixture.session
                }
                controller.conversations = conversations
                controller.setEnabled(false)
                controller.connectForForeground()
                controller.setEnabled(true)
                controller.node.disconnectForBackground()
                conversations.appear()
                try await Self.finishConnection(conversations, fixture: fixture, scopes: scopes)
                try await operation(controller, conversations, fixture)
                await conversations.disconnect(clear: true)
            } catch {
                await fixture.stop()
                throw error
            }
            await fixture.stop()
        }
    }

    private static func finishConnection(
        _ conversations: WatchDirectConversations,
        fixture: WatchGatewayOperatorHTTPFixture,
        scopes: [String] = GatewayOperatorHTTPFixture.scopes,
        token: String = GatewayOperatorHTTPFixture.token) async throws
    {
        var connecting: Task<Void, Never>?
        do {
            var begin = try await fixture.next("begin or retired connection output")
            while begin.request.url?.lastPathComponent != "connections" {
                try #require(begin.request.httpMethod == "DELETE" || begin.request.url?.lastPathComponent == "poll")
                begin = try await fixture.next("begin after retired connection output")
            }
            // Join the initiated connection; an earlier refresh can supersede claimed upgrade cleanup.
            connecting = Task {
                guard !Task.isCancelled else { return }
                await conversations.refresh()
            }
            try begin.respond(status: 201, body: GatewayOperatorHTTPFixture.beginBody())
            let connect = try await Self.nextFrame(fixture, method: "connect")
            #expect(try connect.frame.params?.dictionaryValue?["auth"]?.dictionaryValue?["deviceToken"]?
                .stringValue == token)
            connect.accept(1)
            let poll = try await fixture.next("hello poll")
            try poll.respond(body: GatewayOperatorHTTPFixture.hello(requestID: connect.frame.id, scopes: scopes))
            try await Self.reply(
                fixture, method: "agents.list", sequence: 2, cursor: 2, payload: AnyCodable([
                    "defaultId": "first-agent", "mainKey": "main", "scope": "per-sender",
                    "agents": [["id": "first-agent"], ["id": "second-agent"]],
                ]))
            try await Self.reply(
                fixture, method: "sessions.list", sequence: 3, cursor: 3,
                payload: AnyCodable(["sessions": [["key": "session-one"], ["key": "session-two"]]]))
            await connecting?.value
            #expect(conversations.connected)
        } catch {
            connecting?.cancel()
            await conversations.disconnect(clear: true)
            await connecting?.value
            throw error
        }
    }

    private static func requireOperatorSetup(
        _ controller: WatchGatewayController,
        fixture: WatchGatewayOperatorHTTPFixture,
        scopes: [String] = GatewayOperatorHTTPFixture.scopes) throws
    {
        let configuration = try #require(controller.configuration)
        try #require(controller.isInstalled(configuration))
        try #require(!controller.setupIncomplete && !controller.recoveryRequired, "\(controller.statusText)")
        let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(profile: .primary))
        try #require(identity.deviceId == fixture.identity.deviceId)
        let grant = try #require(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "operator",
            gatewayID: configuration.gatewayID,
            profile: .primary))
        try #require(grant.token == GatewayOperatorHTTPFixture.token)
        try #require(Set(grant.scopes) == Set(scopes))
        try #require(Set(controller.storedOperatorScopes()) == Set(scopes))
    }

    private static func nextFrame(_ fixture: WatchGatewayOperatorHTTPFixture, method: String)
        async throws -> GatewayOperatorHTTPExchange
    {
        var exchange = try await fixture.next("\(method) frame or idle poll")
        while exchange.request.url?.lastPathComponent == "poll" {
            exchange = try await fixture.next("\(method) frame after idle poll")
        }
        try #require(exchange.request.url?.lastPathComponent == "frames")
        try #require(exchange.frame.method == method)
        return exchange
    }

    private static func reply(
        _ fixture: WatchGatewayOperatorHTTPFixture, method: String, sequence: Int, cursor: Int, payload: AnyCodable)
        async throws
    {
        let frame = try await Self.nextFrame(fixture, method: method)
        frame.accept(sequence)
        let poll = try await fixture.next("\(method) result poll")
        try #require(poll.request.url?.lastPathComponent == "poll")
        try poll.respond(body: GatewayOperatorHTTPFixture.delivery(
            requestID: frame.frame.id, payload: payload, cursor: cursor, accepted: sequence))
    }

    private static func replaceSetup(_ controller: WatchGatewayController) async throws {
        let previous = try #require(controller.configuration?.setupSentAtMs)
        // Stop transport startup while the replacement is installed; the original HTTP RPC is still pending.
        controller.disconnectForBackground()
        await controller.configure(
            setupCode: #"{"url":"wss://gateway.example.invalid/replacement","bootstrapToken":"replacement-setup"}"#,
            sentAtMs: previous + 1)
        #expect(controller.configuration?.setupSentAtMs == previous + 1)
    }

    private static func execute(_ url: URL, _ sql: String) throws {
        var database: OpaquePointer?
        let status = sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE, nil)
        defer { if let database { sqlite3_close(database) } }
        try #require(status == SQLITE_OK)
        let opened = try #require(database)
        try #require(sqlite3_exec(opened, sql, nil, nil, nil) == SQLITE_OK)
    }
}
