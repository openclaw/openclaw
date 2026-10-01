import Foundation
import OpenClawKit
import OpenClawNativeActions
import OpenClawProtocol
import Testing

struct NativeSessionStatusTests {
    private typealias Codec = OpenClawNativeSessionStatus

    private func run(
        key: String = "agent:main:status",
        agent: String = "main",
        runID: String = "run-a") -> OpenClawNativeRunRef
    {
        OpenClawNativeRunRef(
            session: OpenClawNativeSessionRef(
                owner: OpenClawNativeOwnerRef(gatewayID: "gateway-a", profileID: "profile-a"),
                agentID: agent,
                sessionKey: key),
            runID: runID)
    }

    private func payload(
        run: OpenClawNativeRunRef,
        generation: String = "generation-a",
        status: Any? = "running",
        matchedRun: Any = NSNull()) -> [String: Any]
    {
        var session: [String: Any] = [
            "key": run.session.sessionKey,
            "agentId": run.session.agentID,
            "sessionId": generation,
            "hasActiveRun": true,
            "matchedRun": matchedRun,
        ]
        session["status"] = status
        return ["observedAt": 42.25, "session": session]
    }

    private func data(_ payload: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    @Test
    func `parameters encode only captured selectors without normalization`() throws {
        let selected = self.run(key: " Agent:main:e\u{301}\n", agent: "Main_1", runID: " e\u{301}\n")
        let generation = " generation-e\u{301}\n"
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let session = try Codec.parameters(for: .session(selected.session, sessionID: generation))
        let run = try Codec.parameters(for: .run(selected, sessionID: generation))
        let sessionJSON = try encoder.encode(session)
        let runJSON = try encoder.encode(run)
        #expect(sessionJSON == Data(
            #"{"agentId":"Main_1","key":" Agent:main:e\#u{301}\n","sessionId":" generation-e\#u{301}\n"}"#.utf8))
        #expect(runJSON == Data(
            #"{"agentId":"Main_1","expectedRunId":" e\#u{301}\n","key":" Agent:main:e\#u{301}\n","sessionId":" generation-e\#u{301}\n"}"#
                .utf8))
    }

    @Test
    func `null session is successful absence with query owner context`() throws {
        let query = Codec.Query.run(self.run(), sessionID: "generation-a")
        let bytes = Data(#"{"observedAt":0,"session":null}"#.utf8)
        let generated = try JSONDecoder().decode(SessionsStatusResult.self, from: bytes)
        #expect(generated.session.value is NSNull)
        let observation = try Codec.decode(bytes, for: query)
        #expect(observation.owner == self.run().session.owner)
        #expect(observation.observedAt == 0)
        #expect(observation.session == nil)
        #expect(throws: GatewayDecodingError.self) {
            try Codec.decode(Data(#"{"ok":false,"error":{"code":"UNAVAILABLE"}}"#.utf8), for: query)
        }
    }

    @Test(arguments: ["done", "failed", "killed", "timeout"])
    func `selected terminal coexists with active successor`(status: String) throws {
        let selected = self.run(runID: "e\u{301}")
        var payload = self.payload(run: selected, matchedRun: [
            "runId": selected.runID, "status": status, "endedAt": 30.75,
        ])
        var row = try #require(payload["session"] as? [String: Any])
        row["updatedAt"] = 40.5
        payload["session"] = row
        let observation = try Codec.decode(self.data(payload), for: .run(selected, sessionID: "generation-a"))
        let session = try #require(observation.session)
        let terminal = try #require(session.matchedRun)
        #expect(observation.observedAt == 42.25)
        #expect(session.ref == selected.session)
        #expect(session.generation.utf8.elementsEqual("generation-a".utf8))
        #expect(session.aggregateStatus == .running)
        #expect(session.hasActiveRun)
        #expect(session.updatedAt == 40.5)
        #expect(terminal.ref == selected)
        #expect(terminal.ref.runID.utf8.elementsEqual(selected.runID.utf8))
        #expect(terminal.status.rawValue == status)
        #expect(terminal.endedAt == 30.75)
    }

    @Test
    func `absent facts and null matched run stay absent`() throws {
        let selected = self.run()
        let bytes = try self.data(self.payload(run: selected, status: nil))
        let generated = try JSONDecoder().decode(SessionsStatusResult.self, from: bytes)
        let row = try GatewayPayloadDecoding.decode(generated.session, as: SessionStatus.self)
        #expect(row.matchedrun.value is NSNull)
        for query in [
            Codec.Query.session(selected.session, sessionID: "generation-a"),
            .run(selected, sessionID: "generation-a"),
        ] {
            let session = try #require(try Codec.decode(bytes, for: query).session)
            #expect(session.aggregateStatus == nil)
            #expect(session.updatedAt == nil)
            #expect(session.matchedRun == nil)
        }
        let terminal = try Codec.decode(
            self.data(self.payload(run: selected, matchedRun: ["runId": "run-a", "status": "done"])),
            for: .run(selected, sessionID: "generation-a"))
        #expect(terminal.session?.matchedRun?.endedAt == nil)
    }

    @Test(arguments: ["key", "agentId", "sessionId", "runId"])
    func `rejects identity mismatch`(field: String) throws {
        let selected = self.run(key: "\u{E9}", runID: "\u{E9}")
        var payload = self.payload(
            run: selected,
            generation: "\u{E9}",
            matchedRun: ["runId": selected.runID, "status": "done"])
        var row = try #require(payload["session"] as? [String: Any])
        if field == "runId" {
            row["matchedRun"] = ["runId": "e\u{301}", "status": "done"]
        } else {
            row[field] = field == "agentId" ? "Main" : "e\u{301}"
        }
        payload["session"] = row
        #expect(throws: GatewayDecodingError.self) {
            try Codec.decode(self.data(payload), for: .run(selected, sessionID: "\u{E9}"))
        }
    }

    @Test
    func `rejects unexpected selected run`() throws {
        let selected = self.run()
        let bytes = try self.data(self.payload(run: selected, matchedRun: ["runId": "run-a", "status": "done"]))
        #expect(throws: GatewayDecodingError.self) {
            try Codec.decode(bytes, for: .session(selected.session, sessionID: "generation-a"))
        }
    }

    @Test(arguments: ["queued", "running", "done", "failed", "killed", "timeout"])
    func `decodes aggregate statuses`(status: String) throws {
        let selected = self.run()
        let result = try Codec.decode(
            self.data(self.payload(run: selected, status: status)),
            for: .session(selected.session, sessionID: "generation-a"))
        #expect(result.session?.aggregateStatus?.rawValue == status)
    }

    @Test(arguments: [
        #"{}"#,
        #"{"observedAt":1}"#,
        #"{"observedAt":true,"session":null}"#,
        #"{"observedAt":1,"session":[]}"#,
        #"{"observedAt":1,"session":{"key":"agent:main:status","agentId":"main","sessionId":"generation-a","hasActiveRun":1,"matchedRun":null}}"#,
    ])
    func `rejects malformed payload without leaking values`(json: String) {
        do {
            _ = try Codec.decode(Data(json.utf8), for: .run(self.run(), sessionID: "generation-a"))
            Issue.record("Malformed payload was accepted")
        } catch let error as GatewayDecodingError {
            #expect(error.method == "sessions.status")
            #expect(error.message == "Invalid session status payload.")
        } catch {
            Issue.record("Expected a bounded GatewayDecodingError")
        }
    }

    @Test(arguments: ["unknown", "running\n", "", "RUNNING"])
    func `rejects malformed aggregate and terminal statuses`(status: String) throws {
        let selected = self.run()
        for payload in [
            self.payload(run: selected, status: status),
            self.payload(run: selected, matchedRun: ["runId": "run-a", "status": status]),
        ] {
            #expect(throws: GatewayDecodingError.self) {
                try Codec.decode(self.data(payload), for: .run(selected, sessionID: "generation-a"))
            }
        }
    }

    @Test(arguments: ["queued", "running"])
    func `rejects nonterminal selected run`(status: String) throws {
        let selected = self.run()
        #expect(throws: GatewayDecodingError.self) {
            try Codec.decode(
                self.data(self.payload(run: selected, matchedRun: ["runId": "run-a", "status": status])),
                for: .run(selected, sessionID: "generation-a"))
        }
    }

    @Test(arguments: ["observedAt", "updatedAt", "endedAt"])
    func `timestamps preserve fractions and reject invalid ranges`(field: String) throws {
        let selected = self.run()
        for value in [0.0, 0.25, 9_007_199_254_740_991, -0.25, 9_007_199_254_740_992] {
            var payload = self.payload(run: selected)
            var row = try #require(payload["session"] as? [String: Any])
            if field == "observedAt" {
                payload[field] = value
            } else if field == "updatedAt" {
                row[field] = value
            } else {
                row["matchedRun"] = ["runId": "run-a", "status": "done", "endedAt": value]
            }
            payload["session"] = row
            let bytes = try self.data(payload)
            if value >= 0, value <= 9_007_199_254_740_991 {
                let result = try Codec.decode(bytes, for: .run(selected, sessionID: "generation-a"))
                let actual = field == "observedAt" ? result.observedAt :
                    field == "updatedAt" ? result.session?.updatedAt : result.session?.matchedRun?.endedAt
                #expect(actual == value)
            } else {
                #expect(throws: GatewayDecodingError.self) {
                    try Codec.decode(bytes, for: .run(selected, sessionID: "generation-a"))
                }
            }
        }
        #expect(throws: GatewayDecodingError.self) {
            try Codec.decode(
                Data(#"{"observedAt":1e400,"session":null}"#.utf8),
                for: .run(selected, sessionID: "generation-a"))
        }
    }

    @Test(arguments: ["status", "updatedAt", "endedAt"])
    func `optional facts reject explicit null`(field: String) throws {
        let selected = self.run()
        var payload = self.payload(run: selected)
        var row = try #require(payload["session"] as? [String: Any])
        if field == "endedAt" {
            row["matchedRun"] = ["runId": "run-a", "status": "done", "endedAt": NSNull()] as [String: Any]
        } else {
            row[field] = NSNull()
        }
        payload["session"] = row
        #expect(throws: GatewayDecodingError.self) {
            try Codec.decode(self.data(payload), for: .run(selected, sessionID: "generation-a"))
        }
    }

    @Test(arguments: [("key", 512), ("sessionId", 128), ("runId", 256)])
    func `scalar bounds preserve spelling and reject overflow`(field: String, maximum: Int) throws {
        for unit in ["a", "\u{301}", "\u{1F600}"] {
            for count in [maximum, maximum + 1] {
                let value = String(repeating: unit, count: count)
                let selected = self.run(
                    key: field == "key" ? value : "agent:main:status",
                    runID: field == "runId" ? value : "run-a")
                let generation = field == "sessionId" ? value : "generation-a"
                let query = Codec.Query.run(selected, sessionID: generation)
                let bytes = try self.data(self.payload(
                    run: selected,
                    generation: generation,
                    matchedRun: ["runId": selected.runID, "status": "done"]))
                if count == maximum {
                    _ = try Codec.parameters(for: query)
                    let result = try Codec.decode(bytes, for: query)
                    #expect(result.session?.ref.sessionKey.utf8.elementsEqual(selected.session.sessionKey.utf8) == true)
                    #expect(result.session?.generation.utf8.elementsEqual(generation.utf8) == true)
                    #expect(result.session?.matchedRun?.ref.runID.utf8.elementsEqual(selected.runID.utf8) == true)
                } else {
                    #expect(throws: GatewayDecodingError.self) { try Codec.parameters(for: query) }
                    #expect(throws: GatewayDecodingError.self) { try Codec.decode(bytes, for: query) }
                }
            }
        }
    }

    @Test(arguments: ["", " \n\t", "\u{FEFF}", String(repeating: "a", count: 512) + "\n"])
    func `rejects blank or overlong key without truncation`(key: String) {
        #expect(throws: GatewayDecodingError.self) {
            try Codec.parameters(for: .session(self.run(key: key).session, sessionID: "generation-a"))
        }
    }

    @Test(arguments: ["main\n", "_main", "-main", "m\u{E9}", String(repeating: "a", count: 65)])
    func `rejects invalid ASCII scoped agent`(agent: String) {
        #expect(throws: GatewayDecodingError.self) {
            try Codec.parameters(for: .session(self.run(agent: agent).session, sessionID: "generation-a"))
        }
    }

    @Test
    func `accepts boundary agent and trailing newline within scalar limit`() throws {
        let selected = self.run(
            key: String(repeating: "a", count: 511) + "\n",
            agent: String(repeating: "a", count: 64))
        let params = try Codec.parameters(for: .session(selected.session, sessionID: "generation-a"))
        #expect(params.key.utf8.elementsEqual(selected.session.sessionKey.utf8))
        #expect(params.agentid == selected.session.agentID)
    }

    @Test
    func `payload cap applies before decoding`() throws {
        let query = Codec.Query.run(self.run(), sessionID: "generation-a")
        let payload = Data(#"{"observedAt":1,"session":null}"#.utf8)
        let boundary = payload + Data(repeating: 32, count: 16 * 1024 - payload.count)
        #expect(try Codec.decode(boundary, for: query).session == nil)
        do {
            _ = try Codec.decode(boundary + Data([32]), for: query)
            Issue.record("Oversized payload was accepted")
        } catch let error as GatewayDecodingError {
            #expect(error.message == "Session status payload exceeds 16384 bytes.")
        }
    }
}
