import Foundation
import OpenClawKit
import Testing

private struct TalkConfigContractFixture: Decodable {
    let timeoutCases: [TimeoutCase]

    struct TimeoutCase: Decodable {
        let id: String
        let fallback: Int
        let expectedTimeoutMs: Int
        let talk: [String: AnyCodable]
    }
}

private enum TalkConfigContractFixtureLoader {
    static func load() throws -> TalkConfigContractFixture {
        let fixtureURL = try self.findFixtureURL(startingAt: URL(fileURLWithPath: #filePath))
        let data = try Data(contentsOf: fixtureURL)
        return try JSONDecoder().decode(TalkConfigContractFixture.self, from: data)
    }

    private static func findFixtureURL(startingAt fileURL: URL) throws -> URL {
        var directory = fileURL.deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appendingPathComponent("test/fixtures/talk-config-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            directory.deleteLastPathComponent()
        }
        throw NSError(domain: "TalkConfigContractFixtureLoader", code: 1)
    }
}

struct TalkConfigContractTests {
    @Test func `timeout fixtures`() throws {
        for fixture in try TalkConfigContractFixtureLoader.load().timeoutCases {
            #expect(
                TalkConfigParsing.resolvedSilenceTimeoutMs(
                    fixture.talk,
                    fallback: fixture.fallback) == fixture.expectedTimeoutMs,
                "\(fixture.id)")
        }
    }
}
