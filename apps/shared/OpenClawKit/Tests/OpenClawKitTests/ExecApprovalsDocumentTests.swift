import Foundation
import Testing
@testable import OpenClawKit

struct ExecApprovalsDocumentTests {
    @Test func `policy snapshot round trip preserves exec rules and MCP grants`() throws {
        let source = Data(
            #"{"version":1,"defaults":{"security":"allowlist","ask":"on-miss"},"agents":{"main":{"allowlist":[{"id":"opaque-id","pattern":"/usr/bin/printf","source":"allow-always","argPattern":" ^safe$ ","lastUsedAt":123,"lastResolvedPath":"/usr/bin/printf"}],"mcpTools":[{"server":"calendar","tool":"list_events","source":"allow-always","addedAt":100,"lastUsedAt":200}]}}}"#
                .utf8)
        let document = try JSONDecoder().decode(ExecApprovalsDocument.self, from: source)
        let encoded = try JSONEncoder().encode(document)
        let expected = try #require(JSONSerialization.jsonObject(with: source) as? NSDictionary)
        let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
        #expect(actual == expected)
        #expect(document.agents?["main"]?.isEmpty == false)
    }

    @Test func `legacy command text never enters encoded policy`() throws {
        let source = Data(
            #"{"version":1,"agents":{"main":{"allowlist":[{"id":"existing","pattern":"/bin/echo","commandText":"legacy argument"}]}}}"#
                .utf8)
        let document = try JSONDecoder().decode(ExecApprovalsDocument.self, from: source)
        #expect(document.agents?["main"]?.allowlist?.first?.commandText == "legacy argument")
        let encoded = try JSONEncoder().encode(document)
        let root = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let agents = try #require(root["agents"] as? [String: Any])
        let main = try #require(agents["main"] as? [String: Any])
        let allowlist = try #require(main["allowlist"] as? [[String: Any]])
        #expect(allowlist.first?["commandText"] == nil)
    }
}
