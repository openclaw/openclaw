import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatDownloadedFileTests {
    @Test(arguments: ["../../report.csv", "..\\report.csv", "report.csv"])
    func `exports stable bytes with a safe filename and cleans up`(fileName: String) throws {
        let first = try ChatDownloadedFile(data: Data("first".utf8), fileName: fileName)
        var second: ChatDownloadedFile? = try ChatDownloadedFile(data: Data("second".utf8), fileName: fileName)
        let secondURL = try #require(second?.url)
        #expect(first.url.lastPathComponent == "report.csv")
        #expect(first.url != secondURL)
        #expect(try Data(contentsOf: first.url) == Data("first".utf8))
        #expect(try Data(contentsOf: secondURL) == Data("second".utf8))
        second = nil
        #expect(!FileManager.default.fileExists(atPath: secondURL.deletingLastPathComponent().path))
        #expect(FileManager.default.fileExists(atPath: first.url.path))
    }
}
