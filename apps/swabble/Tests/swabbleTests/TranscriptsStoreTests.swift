import Foundation
import XCTest
@testable import Swabble

final class TranscriptsStoreTests: XCTestCase {
    func testAppendKeepsConfiguredNumberOfEntries() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = directory.appendingPathComponent("transcripts.log")

        let store = TranscriptsStore(fileURL: log)
        for text in ["one", "two", "three"] {
            await store.append(text: text, maxEntries: 2)
        }

        let latest = await store.latest()
        XCTAssertEqual(latest, ["two", "three"])
        XCTAssertEqual(try String(contentsOf: log, encoding: .utf8), "two\nthree")
        let reloaded = await TranscriptsStore(fileURL: log).latest()
        XCTAssertEqual(reloaded, ["two", "three"])
    }
}
