import Foundation
import OpenClawKit
import Testing

struct NativeConversationContractTests {
    @Test func `native conversation commands preserve their exact payload envelopes`() throws {
        let cases: [(NativeConversationCommand.Action, String)] = [
            (
                .navigate(.init(agentId: "main", sessionKey: "agent:main:thread")),
                #"{"type":"navigate","payload":{"agentId":"main","sessionKey":"agent:main:thread"}}"#),
            (
                .presentation(.init(visible: true, active: false)),
                #"{"type":"presentation","payload":{"visible":true,"active":false}}"#),
            (.focusComposer, #"{"type":"focus-composer","payload":{}}"#),
        ]
        for (action, fixture) in cases {
            let command = NativeConversationCommand(documentId: "document-1", requestId: "request-1", action: action)
            var expected = try Self.object(fixture)
            expected["contract"] = 1
            expected["documentId"] = "document-1"
            expected["requestId"] = "request-1"
            let encoded = try JSONEncoder().encode(command)
            #expect(try JSONSerialization.jsonObject(with: encoded) as? NSDictionary == expected as NSDictionary)
            #expect(try JSONDecoder().decode(NativeConversationCommand.self, from: encoded) == command)
        }
    }

    @Test(arguments: [
        #"{"type":"ready","surface":"conversation","capabilities":["navigate","presentation","focus-composer"]}"#,
        #"""
        {"type":"state","revision":3,"context":{"agentId":"main","sessionKey":"agent:main:thread"},
        "title":"A quoted \"conversation\" 🦞","run":{"active":true},"connection":"signed-out"}
        """#,
        #"{"type":"route-changed","agentId":"main","sessionKey":"agent:main:fork","reason":"fork"}"#,
        #"{"type":"open-dashboard","path":"/settings/providers","search":"?provider=fixture"}"#,
        #"{"type":"command-result","requestId":"request-1","ok":false,"error":"stale-document"}"#,
    ])
    func `web messages round trip as document-bound flat objects`(_ fixture: String) throws {
        var expected = try Self.object(fixture)
        expected["contract"] = 1
        expected["documentId"] = "document-1"
        let data = try JSONSerialization.data(withJSONObject: expected)
        let message = try JSONDecoder().decode(NativeConversationMessage.self, from: data)
        #expect(message.documentId == "document-1")
        let encoded = try JSONEncoder().encode(message)
        #expect(try JSONSerialization.jsonObject(with: encoded) as? NSDictionary == expected as NSDictionary)
        for invalidDocument in [nil, ""] as [String?] {
            expected["documentId"] = invalidDocument
            let invalid = try JSONSerialization.data(withJSONObject: expected)
            #expect(throws: DecodingError.self) {
                try JSONDecoder().decode(NativeConversationMessage.self, from: invalid)
            }
        }
    }

    @Test(arguments: [
        #"{"contract":2,"documentId":"document-1","type":"ready","surface":"conversation","capabilities":[]}"#,
        #"{"contract":1,"documentId":"document-1","type":"ready","surface":"transcript","capabilities":[]}"#,
        #"{"contract":1,"documentId":"document-1","type":"composer-edit","operation":"restore-draft","text":"old"}"#,
        #"{"contract":1,"documentId":"document-1","type":"composer-focus"}"#,
        #"{"contract":1,"documentId":"document-1","type":"session-changed","agentId":"main","sessionKey":"main","reason":"fork"}"#,
        #"{"contract":1,"documentId":"document-1","type":"route-changed","agentId":"main","sessionKey":"main","reason":"future"}"#,
        #"{"contract":1,"documentId":"document-1","type":"open-dashboard","payload":{"path":"/settings"}}"#,
    ])
    func `unsupported web versions legacy transcript messages and malformed payloads are rejected`(_ fixture: String) {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(NativeConversationMessage.self, from: Data(fixture.utf8))
        }
    }

    @Test(arguments: ["submit", "abort", "find", "jump-latest", "export", "future-command"])
    func `pane-local commands from the retired transcript contract are rejected`(_ type: String) throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "contract": 1, "documentId": "document-1", "requestId": "request-1", "type": type, "payload": [:],
        ])
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(NativeConversationCommand.self, from: data)
        }
    }

    @Test(arguments: [
        #"{"contract":2,"documentId":"document-1","requestId":"request-1","type":"focus-composer","payload":{}}"#,
        #"{"contract":1,"documentId":"document-1","requestId":"request-1","type":"focus-composer","payload":[]}"#,
        #"{"contract":1,"documentId":"document-1","requestId":"request-1","type":"focus-composer","payload":{"unexpected":"field"}}"#,
        #"{"contract":1,"requestId":"request-1","type":"focus-composer","payload":{}}"#,
        #"{"contract":1,"documentId":"","requestId":"request-1","type":"focus-composer","payload":{}}"#,
        #"{"contract":1,"documentId":"document-1","type":"focus-composer","payload":{}}"#,
        #"{"contract":1,"documentId":"document-1","requestId":"request-1","type":"navigate","agentId":"main","sessionKey":"main"}"#,
    ])
    func `native commands require supported version document request and payload`(_ fixture: String) {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(NativeConversationCommand.self, from: Data(fixture.utf8))
        }
    }

    private static func object(_ json: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }
}
