import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatNativeRunInspectionTests {
    private let session = OpenClawNativeSessionRef(
        owner: .init(gatewayID: "gateway-a", profileID: "profile-a"),
        agentID: "reviewer",
        sessionKey: "agent:reviewer:main")

    @Test(arguments: ["queued", "running", "done", "failed"])
    func `aggregate activity does not identify selected run`(status: String) throws {
        let history = try self.history(info: [
            "hasActiveRun": true, "activeRunIds": ["other-run"],
            "lastRunId": "provider-run", "status": status,
        ])
        let result = try self.inspect(history)
        #expect(result.association == .notObserved)
        #expect(result.activity == .unknown)
        #expect(result.outcome == nil)
    }

    @Test(arguments: ["pending", "consumed"])
    func `receipts prove association only`(state: String) throws {
        let history = try self.history(
            info: ["status": "running"],
            receipts: [["runId": "client-run", "state": state]])
        let result = try self.inspect(history)
        #expect(result.association == .observed)
        #expect(result.activity == .unknown)
        #expect(result.outcome == nil)
        #expect(result.reply == nil)
    }

    @Test(arguments: ["done", "failed", "killed", "timeout"])
    func `exact last run owns terminal outcome`(status: String) throws {
        let history = try self.history(info: [
            "lastRunId": "client-run", "status": status, "lastRunError": "terminal detail",
        ])
        let result = try self.inspect(history)
        #expect(result.association == .observed)
        #expect(result.outcome?.rawValue == status)
        #expect(result.error == (status == "done" ? nil : "terminal detail"))
    }

    @Test func `exact active ID takes precedence over older terminal projection`() throws {
        let history = try self.history(info: [
            "activeRunIds": ["client-run"], "lastRunId": "client-run", "status": "done",
        ])
        let result = try self.inspect(history)
        #expect(result.activity == .active)
        #expect(result.outcome == nil)
    }

    @Test(arguments: ["running", "unknown"])
    func `last run identity without terminal state proves only association`(status: String) throws {
        let history = try self.history(info: ["lastRunId": "client-run", "status": status])
        let result = try self.inspect(history)
        #expect(result.association == .observed)
        #expect(result.activity == .unknown)
        #expect(result.outcome == nil)
    }

    @Test func `reply does not prove successful completion`() throws {
        let history = try self.history(messages: [[
            "role": "assistant", "content": [["type": "text", "text": "A partial result"]],
            "stopReason": "stop", "__openclaw": ["runId": "client-run"],
        ]])
        let result = try self.inspect(history)
        #expect(result.reply == "A partial result")
        #expect(result.association == .observed)
        #expect(result.outcome == nil)
    }

    @Test func `echoed session key does not prove resolved owner`() throws {
        for info in [
            ["key": "agent:other:main", "agentId": "reviewer"],
            ["key": self.session.sessionKey, "agentId": "other"],
        ] {
            let history = try self.history(info: info)
            #expect(throws: OpenClawNativeActionError.self) {
                try self.inspect(history)
            }
        }
    }

    @Test func `exact run spelling is required`() throws {
        let run = OpenClawNativeRunRef(session: self.session, runID: "run-e\u{301}")
        let history = try self.history(info: [
            "activeRunIds": ["run-\u{E9}"], "lastRunId": "run-\u{E9}", "status": "done",
        ])
        let result = try OpenClawChatNativeRunInspection.reduce(history, run: run)
        #expect(result.association == .notObserved)
        #expect(result.outcome == nil)
    }

    enum ReplyIdentity: CaseIterable, Sendable {
        case assistantRun, assistantIdempotencyKey, consumptionRun, consumedEvent, userIdempotencyKey, followingRun
    }

    @Test(arguments: ReplyIdentity.allCases, [false, true])
    func `reply ownership requires exact UTF 8`(identity: ReplyIdentity, exact: Bool) throws {
        let run = OpenClawNativeRunRef(session: self.session, runID: "run-e\u{301}")
        let candidate = exact ? run.runID : "run-\u{E9}"
        var messages: [[String: Any]] = [
            [
                "role": "user", "content": [["type": "text", "text": "Prompt"]],
                "__openclaw": ["idempotencyKey": "\(run.runID):user"],
            ],
            [
                "role": "assistant", "content": [["type": "text", "text": "Selected reply"]],
                "stopReason": "stop",
            ],
        ]
        var consumptions: [[String: Any]]?
        switch identity {
        case .assistantRun:
            messages.removeFirst()
            messages[0]["__openclaw"] = ["runId": candidate]
        case .assistantIdempotencyKey:
            messages.removeFirst()
            messages[0]["__openclaw"] = ["idempotencyKey": candidate]
        case .consumptionRun:
            messages[0]["__openclaw"] = ["id": "input-event"]
            consumptions = [["runId": candidate, "consumedByEventId": "input-event"]]
        case .consumedEvent:
            messages[0]["__openclaw"] = ["id": candidate]
            consumptions = [["runId": run.runID, "consumedByEventId": run.runID]]
        case .userIdempotencyKey:
            messages[0]["__openclaw"] = ["idempotencyKey": "\(candidate):user"]
        case .followingRun:
            messages.insert([
                "role": "assistant", "content": [["type": "text", "text": "Progress"]],
                "__openclaw": ["runId": candidate],
            ], at: 1)
        }
        let history = try self.history(consumptions: consumptions, messages: messages)
        let result = try OpenClawChatNativeRunInspection.reduce(history, run: run)
        #expect(result.reply == (exact ? "Selected reply" : nil))
        #expect(result.association == (exact ? .observed : .notObserved))
        #expect(result.activity == .unknown)
        #expect(result.outcome == nil)
    }

    private func inspect(_ history: OpenClawChatHistoryPayload) throws -> OpenClawNativeRunInspection {
        try OpenClawChatNativeRunInspection.reduce(history, run: .init(session: self.session, runID: "client-run"))
    }

    private func history(
        info: [String: Any] = [:],
        receipts: [[String: Any]] = [],
        consumptions: [[String: Any]]? = nil,
        messages: [[String: Any]] = []) throws -> OpenClawChatHistoryPayload
    {
        var sessionInfo: [String: Any] = ["key": self.session.sessionKey, "agentId": self.session.agentID]
        sessionInfo.merge(info) { _, current in current }
        var payload: [String: Any] = [
            "sessionKey": self.session.sessionKey,
            "sessionInfo": sessionInfo,
            "inputReceipts": receipts,
            "messages": messages,
        ]
        if let consumptions { payload["inputConsumptions"] = consumptions }
        return try JSONDecoder().decode(
            OpenClawChatHistoryPayload.self, from: JSONSerialization.data(withJSONObject: payload))
    }
}

struct ChatNativeActionGatewayTests {
    private actor Requests {
        var methods: [String] = []
        var expectedProfiles: [String?] = []
        var current = true
        var profileID: String
        let retireAfterHistory: Bool
        let replaceProfileAfterOwner: String?

        init(
            profileID: String = "profile-a",
            retireAfterHistory: Bool = false,
            replaceProfileAfterOwner: String? = nil)
        {
            self.profileID = profileID
            self.retireAfterHistory = retireAfterHistory
            self.replaceProfileAfterOwner = replaceProfileAfterOwner
        }

        func respond(_ request: OpenClawChatGatewayRequest, expectedProfileId: String?) throws -> Data {
            self.methods.append(request.method)
            self.expectedProfiles.append(expectedProfileId)
            if let expectedProfileId, !expectedProfileId.utf8.elementsEqual(self.profileID.utf8) {
                throw GatewayResponseError(
                    method: request.method,
                    code: "INVALID_REQUEST",
                    message: "Selected profile is no longer active",
                    details: [
                        "reason": AnyCodable("EXPECTED_PROFILE_MISMATCH"),
                        "execution": AnyCodable("not_started"),
                    ])
            }
            switch request.method {
            case "users.self":
                let response = try JSONSerialization.data(withJSONObject: ["profile": ["id": self.profileID]])
                if let replaceProfileAfterOwner { self.profileID = replaceProfileAfterOwner }
                return response
            case "sessions.list":
                #expect(request.params["limit"]?.value as? Int == 50)
                return Data(#"""
                {"sessions":[
                  {"key":"agent:reviewer:main","agentId":"reviewer",\#
                "activeRunIds":["visible-run"],"lastRunId":"last-run"},
                  {"key":"agent:reviewer:remote","agentId":"reviewer","hasActiveRun":true,"status":"running"},
                  {"key":"unscoped","lastRunId":"unknown-owner"}
                ]}
                """#.utf8)
            case "chat.history":
                #expect(request.params["sessionKey"]?.value as? String == "agent:reviewer:main")
                #expect(request.params["agentId"]?.value as? String == "reviewer")
                #expect(request.params["limit"]?.value as? Int == 100)
                #expect(request.params["maxChars"]?.value as? Int == 2000)
                #expect(request.params["inputRunIds"]?.value as? [String] == ["client-run"])
                #expect(request.timeoutMs == 10000)
                self.current = !self.retireAfterHistory
                return Data(#"""
                {"sessionKey":"agent:reviewer:main",\#
                "sessionInfo":{"key":"agent:reviewer:main","agentId":"reviewer",\#
                "lastRunId":"client-run","status":"done"}}
                """#.utf8)
            default:
                Issue.record("Unexpected request: \(request.method)")
                throw CancellationError()
            }
        }

        func snapshot() -> [String] {
            self.methods
        }

        func profileSnapshot() -> [String?] {
            self.expectedProfiles
        }

        func isCurrent() -> Bool {
            self.current
        }

        func retire() {
            self.current = false
        }
    }

    @Test func `discovery uses only visible session run I ds without history reads`() async throws {
        let requests = Requests()
        let gateway = OpenClawChatNativeActionGateway(
            gatewayID: "gateway-a",
            gatewayName: "Gateway",
            supportsProfileBinding: { true },
            request: { try await requests.respond($0, expectedProfileId: $1) },
            isCurrent: { true })
        let runs = try await gateway.runs(matching: nil)
        #expect(runs.map(\.runID) == ["visible-run", "last-run"])
        #expect(runs.allSatisfy { $0.session.owner.profileID == "profile-a" })
        #expect(await requests.snapshot() == ["users.self", "sessions.list"])
        #expect(await requests.profileSnapshot() == [nil, "profile-a"])
    }

    @Test(arguments: [
        ("profile-a", "profile-b"),
        ("profile-\u{E9}", "profile-e\u{301}"),
    ])
    func `account mismatch stops before history`(actual: String, expected: String) async {
        let requests = Requests(profileID: actual)
        let gateway = OpenClawChatNativeActionGateway(
            gatewayID: "gateway-a",
            gatewayName: "Gateway",
            supportsProfileBinding: { true },
            request: { try await requests.respond($0, expectedProfileId: $1) },
            isCurrent: { true })
        await #expect(throws: GatewayResponseError.self) {
            try await gateway.history(session: .init(
                owner: .init(gatewayID: "gateway-a", profileID: expected),
                agentID: "reviewer",
                sessionKey: "agent:reviewer:main"))
        }
        #expect(await requests.snapshot() == ["users.self"])
    }

    @Test(arguments: [false, true])
    func `route retirement takes precedence over missing profile binding capability`(retired: Bool) async {
        let requests = Requests()
        let gateway = OpenClawChatNativeActionGateway(
            gatewayID: "gateway-a",
            gatewayName: "Gateway",
            supportsProfileBinding: {
                if retired { await requests.retire() }
                return false
            },
            request: { try await requests.respond($0, expectedProfileId: $1) },
            isCurrent: { await requests.isCurrent() })
        if retired {
            await #expect(throws: CancellationError.self) {
                try await gateway.sessions(matching: nil)
            }
        } else {
            await #expect(throws: OpenClawNativeActionError.self) {
                try await gateway.sessions(matching: nil)
            }
        }
        #expect(await requests.snapshot().isEmpty)
    }

    @Test(arguments: [false, true])
    func `profile replacement on the same route rejects the next read`(catalog: Bool) async {
        let requests = Requests(replaceProfileAfterOwner: "profile-b")
        let gateway = OpenClawChatNativeActionGateway(
            gatewayID: "gateway-a",
            gatewayName: "Gateway",
            supportsProfileBinding: { true },
            request: { try await requests.respond($0, expectedProfileId: $1) },
            isCurrent: { await requests.isCurrent() })
        do {
            if catalog {
                _ = try await gateway.sessions(matching: nil)
            } else {
                _ = try await gateway.history(
                    session: .init(
                        owner: .init(gatewayID: "gateway-a", profileID: "profile-a"),
                        agentID: "reviewer",
                        sessionKey: "agent:reviewer:main"),
                    runID: "client-run")
            }
            Issue.record("Native read crossed the selected profile boundary")
        } catch let error as GatewayResponseError {
            #expect(error.details["reason"]?.stringValue == "EXPECTED_PROFILE_MISMATCH")
            #expect(error.details["execution"]?.stringValue == "not_started")
        } catch {
            Issue.record(error)
        }
        #expect(await requests.isCurrent())
        #expect(await requests.snapshot() == ["users.self", catalog ? "sessions.list" : "chat.history"])
        #expect(await requests.profileSnapshot() == [catalog ? nil : "profile-a", "profile-a"])
    }

    @Test(arguments: [false, true])
    func `inspection is bounded and rejects A connection retired during history`(retired: Bool) async throws {
        let requests = Requests(retireAfterHistory: retired)
        let gateway = OpenClawChatNativeActionGateway(
            gatewayID: "gateway-a",
            gatewayName: "Gateway",
            supportsProfileBinding: { true },
            request: { try await requests.respond($0, expectedProfileId: $1) },
            isCurrent: { await requests.isCurrent() })
        let run = OpenClawNativeRunRef(
            session: .init(
                owner: .init(gatewayID: "gateway-a", profileID: "profile-a"),
                agentID: "reviewer",
                sessionKey: "agent:reviewer:main"),
            runID: "client-run")
        if retired {
            await #expect(throws: CancellationError.self) {
                let history = try await gateway.history(session: run.session, runID: run.runID)
                _ = try OpenClawChatNativeRunInspection.reduce(history, run: run)
            }
        } else {
            let history = try await gateway.history(session: run.session, runID: run.runID)
            let inspection = try OpenClawChatNativeRunInspection.reduce(history, run: run)
            #expect(inspection.outcome == .done)
        }
        #expect(await requests.snapshot() == ["users.self", "chat.history"])
        #expect(await requests.profileSnapshot() == ["profile-a", "profile-a"])
    }
}
