import Foundation
import Testing

@Suite("macOS localization resources")
struct MacLocalizationResourcesTests {
    @Test func zhHansLocalizableStringsContainsSettingsTabs() throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let stringsFile = testFile
            .deletingLastPathComponent() // OpenClawIPCTests
            .deletingLastPathComponent() // Tests
            .appendingPathComponent("Sources/OpenClaw/Resources/zh-Hans.lproj/Localizable.strings")

        #expect(FileManager.default.fileExists(atPath: stringsFile.path))

        let content = try String(contentsOf: stringsFile, encoding: .utf8)
        let keys = Self.extractKeys(from: content)

        let requiredKeys = [
            "General",
            "Channels",
            "Voice Wake",
            "Config",
            "Instances",
            "Sessions",
            "Cron",
            "Skills",
            "Permissions",
            "About",
        ]

        for key in requiredKeys {
            #expect(keys.contains(key), "Missing zh-Hans translation key: \(key)")
        }
    }

    private static func extractKeys(from stringsContent: String) -> Set<String> {
        var keys: Set<String> = []
        for line in stringsContent.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.hasPrefix("\"") else { continue }
            guard let endQuote = trimmed.dropFirst().firstIndex(of: "\"") else { continue }
            let key = String(trimmed[trimmed.index(after: trimmed.startIndex)..<endQuote])
            keys.insert(key)
        }
        return keys
    }
}
