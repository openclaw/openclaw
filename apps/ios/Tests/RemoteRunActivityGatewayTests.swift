import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawNativeActions
import OpenClawProtocol
import Testing
@testable import OpenClaw

private actor RunActivityGatewayFixture {
    private(set) var requests: [OpenClawChatGatewayRequest] = []
    var current = true
    var preparationFailures = 0
    var replacementProfile: String?
    var retireDuringPreparation = false

    static let run = OpenClawNativeRunRef(
        session: .init(
            owner: .init(gatewayID: "local-gateway", profileID: "profile"),
            agentID: "agent",
            sessionKey: "agent:agent:main"),
        runID: "accepted-run")

    func configure(failures: Int = 0, profile: String? = nil, retire: Bool = false) {
        self.preparationFailures = failures
        self.replacementProfile = profile
        self.retireDuringPreparation = retire
    }

    func respond(_ request: OpenClawChatGatewayRequest) throws -> Data {
        self.requests.append(request)
        switch request.method {
        case "gateway.identity.get":
            return Data(#"{"deviceId":"gateway-device","publicKey":"gateway-public-key"}"#.utf8)
        case "sessions.status":
            return Data("""
            {"observedAt":1800000000000,"session":{"key":"agent:agent:main","agentId":"agent",
            "sessionId":"session-generation","hasActiveRun":true,"matchedRun":null}}
            """.utf8)
        case "push.liveActivity.prepare":
            if self.preparationFailures > 0 {
                self.preparationFailures -= 1
                throw GatewayResponseError(
                    method: request.method,
                    code: "UNAVAILABLE",
                    message: "Not ready",
                    details: ["retryable": AnyCodable(true), "retryAfterMs": AnyCodable(1)])
            }
            if self.retireDuringPreparation { self.current = false }
            return try Self.preparation(profile: self.replacementProfile ?? "profile")
        default:
            throw URLError(.unsupportedURL)
        }
    }

    static func preparation(profile: String = "profile", status: String = "running") throws -> Data {
        let fields: [String: AnyCodable] = [
            "binding": AnyCodable([
                "gatewayId": "gateway-device", "deviceId": "phone-device", "nodeId": "paired-node",
                "pairingGeneration": String(repeating: "a", count: 64), "profileId": profile,
                "agentId": "agent", "sessionKey": "agent:agent:main",
                "sessionId": "session-generation", "lifecycleRevision": NSNull(),
                "publicRunId": "accepted-run",
            ] as [String: Any]),
            "sourceIncarnation": AnyCodable("source-incarnation"),
            "snapshot": AnyCodable([
                "sourceIncarnation": "source-incarnation", "sequence": 1,
                "status": status, "observedAtMs": 1_800_000_000_000,
            ] as [String: Any]),
        ]
        return try JSONEncoder().encode(fields)
    }

    nonisolated var gateway: RemoteRunActivityGateway {
        RemoteRunActivityGateway(
            session: Self.run.session,
            request: { try await self.respond($0) },
            isCurrent: { await self.current })
    }
}

@Suite(.timeLimit(.minutes(1)))
struct RemoteRunActivityGatewayTests {
    @Test func `missing generation uses bounded status then exact run preparation`() async throws {
        let fixture = RunActivityGatewayFixture()
        let prepared = try await fixture.gateway.prepare(run: RunActivityGatewayFixture.run, sessionID: nil)
        #expect(prepared.selection.attributes.sessionId == "session-generation")
        #expect(prepared.selection.attributes.gatewayId == "local-gateway")
        #expect(prepared.selection.attributes.gatewayDeviceId == "gateway-device")
        #expect(prepared.selection.attributes.runId == "accepted-run")
        let requests = await fixture.requests
        #expect(requests.map(\.method) == [
            "gateway.identity.get", "sessions.status", "push.liveActivity.prepare",
        ])
        let status = try #require(requests.first { $0.method == "sessions.status" })
        #expect(status.params["sessionId"] == nil)
        #expect(status.params["expectedRunId"] == nil)
        let prepare = try #require(requests.last)
        #expect(prepare.params["sessionId"]?.value as? String == "session-generation")
        #expect(prepare.params["publicRunId"]?.value as? String == "accepted-run")
        #expect(requests.allSatisfy { $0.timeoutMs > 0 && $0.timeoutMs <= 3000 })
        #expect(prepared.content.startedAt == nil)
        #expect(prepared.content.observedAt.timeIntervalSince1970 == 1_800_000_000)
    }

    @Test func `received acknowledgement can wait for the delayed canonical start fact`() async throws {
        let fixture = RunActivityGatewayFixture()
        await fixture.configure(failures: 2)
        let prepared = try await fixture.gateway.prepare(
            run: RunActivityGatewayFixture.run, sessionID: "session-generation")
        #expect(prepared.content.status == .running)
        #expect(await fixture.requests.filter { $0.method == "push.liveActivity.prepare" }.count == 3)
        #expect(await fixture.requests.contains { $0.method == "chat.send" } == false)
    }

    @Test func `preparation exhaustion does not invent execution or resend`() async throws {
        let fixture = RunActivityGatewayFixture()
        await fixture.configure(failures: 10)
        await #expect(throws: RemoteRunActivityGateway.Failure.unavailable) {
            try await fixture.gateway.prepare(run: RunActivityGatewayFixture.run, sessionID: "session-generation")
        }
        #expect(await fixture.requests.filter { $0.method == "push.liveActivity.prepare" }.count == 4)
    }

    @Test(arguments: [false, true])
    func `wrong owner and retirement during response cannot authorize an activity`(retire: Bool) async throws {
        let fixture = RunActivityGatewayFixture()
        await fixture.configure(profile: retire ? nil : "foreign-profile", retire: retire)
        await #expect(throws: (any Error).self) {
            try await fixture.gateway.prepare(run: RunActivityGatewayFixture.run, sessionID: "session-generation")
        }
    }

    @Test func `canonically equivalent profile spelling is still a different owner`() async throws {
        let session = OpenClawNativeSessionRef(
            owner: .init(gatewayID: "local-gateway", profileID: "caf\u{E9}"),
            agentID: "agent",
            sessionKey: "agent:agent:main")
        let gateway = RemoteRunActivityGateway(
            session: session,
            request: { request in
                if request.method == "gateway.identity.get" {
                    return Data(#"{"deviceId":"gateway-device","publicKey":"gateway-public-key"}"#.utf8)
                }
                return try RunActivityGatewayFixture.preparation(profile: "cafe\u{301}")
            },
            isCurrent: { true })
        await #expect(throws: (any Error).self) {
            try await gateway.prepare(
                run: .init(session: session, runID: "accepted-run"), sessionID: "session-generation")
        }
    }

    @Test(arguments: ["done", "failed", "killed", "timeout", "unknown"])
    func `terminal or unknown prepare snapshots never start a new activity`(status: String) async throws {
        let gateway = RemoteRunActivityGateway(
            session: RunActivityGatewayFixture.run.session,
            request: { request in
                if request.method == "gateway.identity.get" {
                    return Data(#"{"deviceId":"gateway-device","publicKey":"gateway-public-key"}"#.utf8)
                }
                return try RunActivityGatewayFixture.preparation(status: status)
            },
            isCurrent: { true })
        await #expect(throws: (any Error).self) {
            try await gateway.prepare(run: RunActivityGatewayFixture.run, sessionID: "session-generation")
        }
    }

    @Test(arguments: ["running", "toolRunning", "approvalNeeded"])
    func `all active wire states retain their category and unknown start time`(status: String) async throws {
        let gateway = RemoteRunActivityGateway(
            session: RunActivityGatewayFixture.run.session,
            request: { request in
                if request.method == "gateway.identity.get" {
                    return Data(#"{"deviceId":"gateway-device","publicKey":"gateway-public-key"}"#.utf8)
                }
                return try RunActivityGatewayFixture.preparation(status: status)
            },
            isCurrent: { true })
        let prepared = try await gateway.prepare(
            run: RunActivityGatewayFixture.run, sessionID: "session-generation")
        #expect(prepared.content.status.rawValue == status)
        #expect(prepared.content.startedAt == nil)
        #expect(prepared.content.endedAt == nil)
    }

    @Test(arguments: ["source", "private-content", "fractional-sequence", "active-ended-at"])
    func `malformed or cross source snapshots fail before activity construction`(mutation: String) async throws {
        var payload = try #require(
            JSONSerialization.jsonObject(with: RunActivityGatewayFixture.preparation()) as? [String: Any])
        var snapshot = try #require(payload["snapshot"] as? [String: Any])
        switch mutation {
        case "source": snapshot["sourceIncarnation"] = "another-source"
        case "private-content": snapshot["prompt"] = "not permitted content"
        case "fractional-sequence": snapshot["sequence"] = 1.5
        default: snapshot["endedAtMs"] = 1_800_000_000_000
        }
        payload["snapshot"] = snapshot
        let response = try JSONSerialization.data(withJSONObject: payload)
        let gateway = RemoteRunActivityGateway(
            session: RunActivityGatewayFixture.run.session,
            request: { request in
                if request.method == "gateway.identity.get" {
                    return Data(#"{"deviceId":"gateway-device","publicKey":"gateway-public-key"}"#.utf8)
                }
                return response
            },
            isCurrent: { true })
        await #expect(throws: (any Error).self) {
            try await gateway.prepare(run: RunActivityGatewayFixture.run, sessionID: "session-generation")
        }
    }
}
