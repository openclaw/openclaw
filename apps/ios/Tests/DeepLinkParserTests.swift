import ClawdisKit
import Foundation
import Testing

@Suite struct DeepLinkParserTests {
    @Test func parseRejectsNonClawdisScheme() {
        let url = URL(string: "https://example.com/agent?message=hi")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseRejectsEmptyMessage() {
        let url = URL(string: "clawdis://agent?message=%20%20%0A")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func parseAgentLinkParsesCommonFields() {
        let url = URL(string: "clawdis://agent?message=Hello&deliver=1&sessionKey=node-iris&thinking=low&timeoutSeconds=30")!
        #expect(
            DeepLinkParser.parse(url) == .agent(
                .init(
                    message: "Hello",
                    sessionKey: "node-iris",
                    thinking: "low",
                    deliver: true,
                    to: nil,
                    channel: nil,
                    timeoutSeconds: 30,
                    key: nil)))
    }

    @Test func parseRejectsNegativeTimeoutSeconds() {
        let url = URL(string: "clawdis://agent?message=Hello&timeoutSeconds=-1")!
        #expect(DeepLinkParser.parse(url) == .agent(.init(
            message: "Hello",
            sessionKey: nil,
            thinking: nil,
            deliver: false,
            to: nil,
            channel: nil,
            timeoutSeconds: nil,
            key: nil)))
    }
}
