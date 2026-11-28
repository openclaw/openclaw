import Foundation
import Testing

struct ShareAgentRequestPayloadTests {
    @Test func `encoded share inherits thinking and preserves content and delivery`() throws {
        let request = ShareAgentRequestPayload(
            message: "Review https://example.com/article",
            sessionKey: "agent:main:main",
            deliver: true,
            attachments: [.init(
                type: "image",
                mimeType: "image/png",
                fileName: "example.png",
                content: "aW1hZ2U=")],
            receipt: true,
            receiptText: "Received",
            to: "fixture-recipient",
            channel: "fixture-channel",
            timeoutSeconds: 25,
            key: "fixture-share")
        let data = try JSONEncoder().encode(request)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["thinking"] == nil)
        let expected: [String: Any] = [
            "message": "Review https://example.com/article",
            "sessionKey": "agent:main:main",
            "deliver": true,
            "attachments": [[
                "type": "image",
                "mimeType": "image/png",
                "fileName": "example.png",
                "content": "aW1hZ2U=",
            ]],
            "receipt": true,
            "receiptText": "Received",
            "to": "fixture-recipient",
            "channel": "fixture-channel",
            "timeoutSeconds": 25,
            "key": "fixture-share",
        ]
        #expect(NSDictionary(dictionary: json).isEqual(to: expected))
    }
}
