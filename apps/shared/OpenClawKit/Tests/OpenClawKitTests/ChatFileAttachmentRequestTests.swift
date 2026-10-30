import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatFileAttachmentRequestTests {
    @Test(arguments: [
        ("application/pdf", "report.pdf"),
        ("audio/mpeg", "recording.mp3"),
    ])
    func `non-image sends retain file MIME filename and base64 bytes`(mimeType: String, fileName: String) throws {
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: "agent:main:main",
            agentID: nil,
            expectedSessionRoutingContract: nil,
            expectedSessionSettings: nil,
            supportsSessionSettingsCAS: false,
            message: "See attached.",
            thinking: nil,
            idempotencyKey: "send-file",
            attachments: [.init(type: "file", mimeType: mimeType, fileName: fileName, content: "ZmlsZQ==")])
        let encoded = try JSONEncoder().encode(request.params)
        let envelope = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let attachments = try #require(envelope["attachments"] as? [[String: String]])

        #expect(request.method == "chat.send")
        #expect(attachments == [[
            "type": "file",
            "mimeType": mimeType,
            "fileName": fileName,
            "content": "ZmlsZQ==",
        ]])
    }
}
