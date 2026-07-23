import Foundation
import XCTest
@testable import OpenClawChatUI

final class ChatMessageMediaAttachmentTests: XCTestCase {
    func testDecodesAssistantImageMediaPathAsRenderableAttachment() throws {
        let message = try decode(
            #"{"role":"assistant","content":"Scan this code.","MediaPath":"media/inbound/code.png","MediaType":"image/png"}"#)

        XCTAssertEqual(message.content.count, 2)
        XCTAssertEqual(message.content[1].type, "file")
        XCTAssertEqual(message.content[1].mimeType, "image/png")
        XCTAssertEqual(message.content[1].fileName, "code.png")
        XCTAssertEqual(message.content[1].mediaPath, "media/inbound/code.png")
    }

    func testDecodesMultipleMediaKindsInOriginalOrder() throws {
        let message = try decode(
            #"{"role":"assistant","content":[],"MediaPaths":["/tmp/one.jpg","/tmp/two.pdf","/tmp/three.m4a"],"MediaTypes":["image/jpeg","application/pdf","audio/mp4"]}"#)

        XCTAssertEqual(message.content.map(\.mimeType), ["image/jpeg", "application/pdf", "audio/mp4"])
        XCTAssertEqual(message.content.map(\.mediaPath), ["/tmp/one.jpg", "/tmp/two.pdf", "/tmp/three.m4a"])
    }

    func testSkipsMediaWithoutMatchingTypeMetadata() throws {
        let message = try decode(
            #"{"role":"assistant","content":[],"MediaPaths":["/tmp/one.png","/tmp/two.png"],"MediaTypes":["image/png"]}"#)

        XCTAssertEqual(message.content.count, 1)
        XCTAssertEqual(message.content[0].mediaPath, "/tmp/one.png")
    }

    func testSkipsBlankMediaMetadata() throws {
        let message = try decode(
            #"{"role":"assistant","content":[],"MediaPaths":["   ","/tmp/two.png"],"MediaTypes":["image/png","   "]}"#)

        XCTAssertTrue(message.content.isEmpty)
    }

    func testDeduplicatesNormalizedMediaPathsAndAudioKinds() throws {
        let message = try decode(
            #"{"role":"assistant","content":[],"MediaPaths":[" /tmp/one.png ","/tmp/one.png","/tmp/voice-1.m4a","/tmp/voice-2.m4a"],"MediaTypes":["image/png","image/png","audio/mp4","audio/mp4"]}"#)

        XCTAssertEqual(
            message.content.map(\.mediaPath),
            ["/tmp/one.png", "/tmp/voice-1.m4a", "/tmp/voice-2.m4a"])
    }

    func testAttachmentDisplayCapsImagesButPreservesOtherFiles() {
        let images = (0..<6).map { index in
            OpenClawChatMessageContent(
                type: "file",
                text: nil,
                mimeType: "image/png",
                fileName: "\(index).png",
                mediaPath: "/tmp/\(index).png",
                content: nil)
        }
        let document = OpenClawChatMessageContent(
            type: "file",
            text: nil,
            mimeType: "application/pdf",
            fileName: "report.pdf",
            mediaPath: "/tmp/report.pdf",
            content: nil)

        let presentation = ChatMessageAttachmentDisplayPolicy.partition(images + [document])

        XCTAssertEqual(presentation.visible.count, 5)
        XCTAssertEqual(presentation.visible.last?.fileName, "report.pdf")
        XCTAssertEqual(presentation.omittedImageCount, 2)
    }

    func testExistingAudioBlockStillPreventsTranscriptAudioDuplicate() throws {
        let message = try decode(
            #"{"role":"assistant","content":[{"type":"file","mimeType":"audio/mp4","fileName":"voice.m4a"}],"MediaPaths":["/tmp/voice.m4a","/tmp/image.png"],"MediaTypes":["audio/mp4","image/png"]}"#)

        XCTAssertEqual(message.content.count, 2)
        XCTAssertEqual(message.content.filter { $0.mimeType == "audio/mp4" }.count, 1)
        XCTAssertEqual(message.content.last?.mediaPath, "/tmp/image.png")
    }

    func testMediaPathSurvivesContentRoundTrip() throws {
        let original = OpenClawChatMessageContent(
            type: "file",
            text: nil,
            mimeType: "image/png",
            fileName: "code.png",
            mediaPath: "media/inbound/code.png",
            content: nil)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(OpenClawChatMessageContent.self, from: encoded)

        XCTAssertEqual(decoded, original)
    }

    func testImageDecoderAcceptsImageAndRejectsNonImageBytes() throws {
        let png = try XCTUnwrap(Data(base64Encoded:
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))

        let image = try XCTUnwrap(ChatMediaImageDecoder.decode(png))
        XCTAssertEqual(image.width, 1)
        XCTAssertEqual(image.height, 1)
        XCTAssertNil(ChatMediaImageDecoder.decode(Data("not an image".utf8)))
    }

    private func decode(_ json: String) throws -> OpenClawChatMessage {
        try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
    }
}
