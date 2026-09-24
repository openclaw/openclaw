import Foundation
import XCTest
@testable import OpenClawChatUI

/// Uses only pre-fix model APIs so replay on the baseline fails on lost metadata, not compilation.
final class ManagedDocumentEnvelopeTests: XCTestCase {
    func testHistoryAndCachePreserveDocumentMetadata() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(
            forResource: "managed-document-message", withExtension: "json"))
        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(contentsOf: url))
        let attachment = try XCTUnwrap(message.content.last)
        XCTAssertEqual(attachment.fileName, "report.csv", "MANAGED_DOCUMENT_METADATA_LOST")
        XCTAssertEqual(attachment.mimeType, "text/csv")
        XCTAssertEqual(attachment.sizeBytes, 18)
        XCTAssertEqual(attachment.artifactId, "artifact_managed_media_11111111-1111-4111-8111-111111111111")
        XCTAssertTrue(attachment.isInlineAttachment)
        let cached = try XCTUnwrap(OpenClawChatSQLiteTranscriptCache.cacheableMessages([message]).first)
        let reloaded = try JSONDecoder().decode(OpenClawChatMessage.self, from: JSONEncoder().encode(cached))
        XCTAssertEqual(reloaded.content.last?.fileName, "report.csv", "MANAGED_DOCUMENT_METADATA_LOST")
        XCTAssertEqual(reloaded.content.last?.artifactId, attachment.artifactId)
    }
}
