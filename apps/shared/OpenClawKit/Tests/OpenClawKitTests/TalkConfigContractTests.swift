import Foundation
import OpenClawKit
import Testing

private struct TalkConfigContractFixture: Decodable {
    let selectionCases: [SelectionCase]

    struct SelectionCase: Decodable {
        let id: String
        let defaultProvider: String
        let payloadValid: Bool
        let expectedSelection: ExpectedSelection?
        let talk: [String: AnyCodable]
    }

    struct ExpectedSelection: Decodable {
        let provider: String
        let normalizedPayload: Bool
        let voiceId: String?
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
            let candidate = directory.appendingPathComponent("test-fixtures/talk-config-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            directory.deleteLastPathComponent()
        }
        throw NSError(domain: "TalkConfigContractFixtureLoader", code: 1)
    }
}

struct TalkConfigContractTests {
    @Test func selectionFixtures() throws {
        for fixture in try TalkConfigContractFixtureLoader.load().selectionCases {
            let selection = TalkConfigParsing.selectProviderConfig(
                fixture.talk,
                defaultProvider: fixture.defaultProvider)
            if let expected = fixture.expectedSelection {
                #expect(selection != nil)
                #expect(selection?.provider == expected.provider)
                #expect(selection?.normalizedPayload == expected.normalizedPayload)
                #expect(selection?.config["voiceId"]?.stringValue == expected.voiceId)
            } else {
                #expect(selection == nil)
            }
            #expect(fixture.payloadValid == (selection != nil))
        }
    }
}
