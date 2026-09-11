import Foundation
import Testing
@testable import OpenClaw

struct OpenClawRunActivityAttributesTests {
    private typealias Attributes = OpenClawRunActivityAttributes
    private typealias State = Attributes.ContentState

    private static let selectors = [
        "gatewayId": "gateway-a",
        "gatewayDeviceId": "gateway-device-a",
        "deviceId": "device-a",
        "profileId": "profile-a",
        "agentId": "main",
        "sessionKey": "agent:main:activity",
        "sessionId": "session-a",
        "runId": "run-a",
    ]

    private func attributes(_ fields: [String: String]) throws -> Attributes {
        try JSONDecoder().decode(
            Attributes.self,
            from: JSONSerialization.data(withJSONObject: fields))
    }

    @Test(arguments: ["running", "toolRunning", "approvalNeeded", "completed", "failed", "cancelled", "timedOut"])
    func `server content uses Apple epoch dates and closed categorical states`(status: String) throws {
        let terminal = ["completed", "failed", "cancelled", "timedOut"].contains(status)
        let endField = terminal ? #","endedAt":41.5"# : ""
        let json = #"{"status":"\#(status)","observedAt":42.25,"startedAt":40\#(endField)}"#
        let state = try JSONDecoder().decode(State.self, from: Data(json.utf8))

        #expect(state.status.rawValue == status)
        #expect(state.observedAt.timeIntervalSince1970 == 978_307_242.25)
        #expect(state.startedAt?.timeIntervalSince1970 == 978_307_240)
        #expect(state.endedAt?.timeIntervalSince1970 == (terminal ? 978_307_241.5 : nil))
        #expect(state.presentation(isStale: false) == .status(state.status))
        #expect(state.presentation(isStale: true) == (terminal ? .status(state.status) : .updateDelayed))

        let encoded = try JSONEncoder().encode(state)
        let fields = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(fields["status"] as? String == status)
        #expect(fields["observedAt"] as? Double == 42.25)
        #expect(fields["startedAt"] as? Double == 40)
        #expect(fields["endedAt"] as? Double == (terminal ? 41.5 : nil))
        #expect(Set(fields.keys) == Set(terminal
                ? ["status", "observedAt", "startedAt", "endedAt"]
                : ["status", "observedAt", "startedAt"]))
        #expect(try JSONDecoder().decode(State.self, from: encoded) == state)
    }

    @Test(arguments: ["running", "completed"])
    func `missing dates stay unknown even for a completed run`(status: String) throws {
        let json = #"{"status":"\#(status)","observedAt":-978307200}"#
        let state = try JSONDecoder().decode(State.self, from: Data(json.utf8))
        #expect(state.observedAt == Date(timeIntervalSince1970: 0))
        #expect(state.startedAt == nil)
        #expect(state.endedAt == nil)
        let encoded = try JSONEncoder().encode(state)
        let fields = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(Set(fields.keys) == Set(["status", "observedAt"]))
    }

    @Test(arguments: [
        #"{"status":"paused","observedAt":0}"#,
        #"{"status":"disconnected","observedAt":0}"#,
        #"{"status":"unknown","observedAt":0}"#,
        #"{"status":"running"}"#,
        #"{"status":"running","observedAt":null}"#,
        #"{"status":"running","observedAt":true}"#,
        #"{"status":"running","observedAt":-978307201}"#,
        #"{"status":"running","observedAt":9007199254741}"#,
        #"{"status":"running","observedAt":0,"startedAt":null}"#,
        #"{"status":"completed","observedAt":0,"endedAt":null}"#,
        #"{"status":"running","observedAt":0,"endedAt":0}"#,
        #"{"status":"running","observedAt":0,"startedAt":1}"#,
        #"{"status":"completed","observedAt":0,"endedAt":1}"#,
        #"{"status":"completed","observedAt":10,"startedAt":5,"endedAt":4}"#,
    ])
    func `invalid facts do not become a plausible run state`(json: String) {
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(State.self, from: Data(json.utf8))
        }
    }

    @Test(arguments: [Double.nan, Double.infinity, -Double.infinity, -1, 9_007_199_254_741])
    func `construction rejects dates outside the source contract`(seconds: Double) {
        #expect(throws: Attributes.ValidationError.invalidContent) {
            try State(status: .running, observedAt: Date(timeIntervalSince1970: seconds))
        }
    }

    @Test(arguments: [
        "gatewayId", "gatewayDeviceId", "deviceId", "profileId", "agentId", "sessionKey", "sessionId", "runId",
    ])
    func `every captured selector participates in byte exact identity`(field: String) throws {
        var fields = Self.selectors
        fields[field] = field == "agentId" ? "Main" : "\u{E9}"
        let first = try self.attributes(fields)
        fields[field] = field == "agentId" ? "main" : "e\u{301}"
        let second = try self.attributes(fields)

        #expect(first != second)
        #expect(Set([first, second]).count == 2)
        let encoded = try JSONEncoder().encode(second)
        let restored = try JSONDecoder().decode(Attributes.self, from: encoded)
        #expect(restored == second)
        #expect(restored != first)
        let wire = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        let expected = try #require(fields[field])
        #expect(Set(wire.keys) == Set(Self.selectors.keys))
        #expect(wire[field]?.utf8.elementsEqual(expected.utf8) == true)
    }

    @Test(arguments: [
        ("gatewayId", 256), ("gatewayDeviceId", 256), ("deviceId", 256), ("profileId", 128),
        ("agentId", 64), ("sessionKey", 512), ("sessionId", 128), ("runId", 256),
    ])
    func `identifier limits reject overflow without truncation`(field: String, maximum: Int) throws {
        var fields = Self.selectors
        fields[field] = String(repeating: "a", count: maximum)
        _ = try self.attributes(fields)
        fields[field] = String(repeating: "a", count: maximum + 1)
        #expect(throws: Attributes.ValidationError.invalidIdentity) {
            try self.attributes(fields)
        }
    }

    @Test
    func `scalar limits preserve combining marks and meaningful whitespace`() throws {
        var fields = Self.selectors
        fields["sessionKey"] = String(repeating: "e\u{301}", count: 256)
        _ = try self.attributes(fields)
        fields["sessionKey"] = String(repeating: "e\u{301}", count: 256) + "a"
        #expect(throws: Attributes.ValidationError.invalidIdentity) {
            try self.attributes(fields)
        }
        fields["sessionKey"] = " e\u{301} "
        let value = try self.attributes(fields)
        #expect(value.sessionKey.utf8.elementsEqual(" e\u{301} ".utf8))
        fields["sessionKey"] = " \u{FEFF}"
        #expect(throws: Attributes.ValidationError.invalidIdentity) {
            try self.attributes(fields)
        }
    }

    @Test(arguments: ["", "_main", "-main", "m\u{E9}", "main\n"])
    func `agent selectors retain the native ASCII contract`(agent: String) {
        var fields = Self.selectors
        fields["agentId"] = agent
        #expect(throws: Attributes.ValidationError.invalidIdentity) {
            try self.attributes(fields)
        }
    }

    @Test(arguments: [
        "gatewayId", "gatewayDeviceId", "deviceId", "profileId", "agentId", "sessionKey", "sessionId", "runId",
    ])
    func `activity owner strings reject every ASCII control`(field: String) throws {
        for value in UInt32(0)...UInt32(0x001F) {
            let scalar = try #require(UnicodeScalar(value))
            var fields = Self.selectors
            fields[field] = "a\(scalar)b"
            #expect(throws: Attributes.ValidationError.invalidIdentity) {
                try self.attributes(fields)
            }
        }
    }

    @Test
    func `escaped attributes reserve the full future content budget`() throws {
        var fields = [
            "gatewayId": String(repeating: "a", count: 256),
            "gatewayDeviceId": String(repeating: "a", count: 256),
            "deviceId": String(repeating: "a", count: 256),
            "profileId": String(repeating: "a", count: 128),
            "agentId": String(repeating: "a", count: 64),
            "sessionKey": String(repeating: "a", count: 512),
            "sessionId": String(repeating: "a", count: 128),
            "runId": String(repeating: "a", count: 256),
        ]
        let base = try JSONSerialization.data(withJSONObject: fields).count
        let escapes = 2048 - base
        try #require((0..<256).contains(escapes))
        fields["runId"] = String(repeating: "\"", count: escapes) + String(repeating: "a", count: 256 - escapes)
        let value = try self.attributes(fields)
        let encoded = try JSONEncoder().encode(value)
        #expect(encoded.count == 2048)
        #expect(encoded.count + Attributes.maximumContentBytes == 4096)
        for status in State.Status.allCases {
            let state = try State(status: status, observedAt: Date(timeIntervalSince1970: 100))
            let content = try JSONEncoder().encode(state)
            #expect(content.count <= Attributes.maximumContentBytes)
            #expect(encoded.count + content.count <= 4096)
        }

        fields["runId"] = String(repeating: "\"", count: escapes + 1) +
            String(repeating: "a", count: 255 - escapes)
        #expect(throws: Attributes.ValidationError.payloadTooLarge) {
            try self.attributes(fields)
        }
    }

    @Test
    func `multibyte selectors cannot consume the content reserve`() {
        var fields = Self.selectors
        fields["sessionKey"] = String(repeating: "\u{1F600}", count: 512)
        #expect(throws: Attributes.ValidationError.payloadTooLarge) {
            try self.attributes(fields)
        }
    }
}
