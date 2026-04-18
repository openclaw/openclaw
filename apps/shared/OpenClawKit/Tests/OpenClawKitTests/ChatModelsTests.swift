import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatModelsTests {
    @Test
    func decodesTranscriptMediaPathsIntoImageContentBlocks() throws {
        let json = """
        {
          "role": "user",
          "content": "See attached.",
          "timestamp": 123,
          "MediaPaths": ["/tmp/test-image.png"],
          "MediaTypes": ["image/png"]
        }
        """

        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))

        #expect(message.content.count == 2)
        #expect(message.content[0].text == "See attached.")
        #expect(message.content[1].type == "image")
        #expect(message.content[1].mimeType == "image/png")
        #expect(message.content[1].fileName == "test-image.png")
        #expect(message.content[1].content?.value as? String == "/tmp/test-image.png")
    }

    @Test
    func decodesImageBlockSourceIntoContent() throws {
        let json = """
        {
          "role": "assistant",
          "content": [
            {
              "type": "image",
              "mimeType": "image/png",
              "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": "QUJDRA=="
              }
            }
          ],
          "timestamp": 123
        }
        """

        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
        let content = try #require(message.content.first)
        let source = try #require(content.content?.value as? [String: AnyCodable])

        #expect(content.type == "image")
        #expect(source["data"]?.value as? String == "QUJDRA==")
    }
}
