import Foundation
import Testing

@Suite(.serialized)
struct MacPermissionsMetadataTests {
    private func repoRoot() throws -> URL {
        var cursor = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        for _ in 0..<8 {
            let infoPlist = cursor.appendingPathComponent(
                "apps/macos/Sources/OpenClaw/Resources/Info.plist")
            let codesignScript = cursor.appendingPathComponent("scripts/codesign-mac-app.sh")
            if FileManager.default.fileExists(atPath: infoPlist.path),
               FileManager.default.fileExists(atPath: codesignScript.path)
            {
                return cursor
            }
            cursor.deleteLastPathComponent()
        }
        throw NSError(domain: "MacPermissionsMetadataTests", code: 1, userInfo: nil)
    }

    @Test func infoPlistIncludesCalendarReminderAndContactsUsageKeys() throws {
        let root = try self.repoRoot()
        let plistPath = root.appendingPathComponent("apps/macos/Sources/OpenClaw/Resources/Info.plist")
        let plist = try String(contentsOf: plistPath, encoding: .utf8)

        #expect(plist.contains("<key>NSCalendarsUsageDescription</key>"))
        #expect(plist.contains("<key>NSRemindersUsageDescription</key>"))
        #expect(plist.contains("<key>NSRemindersFullAccessUsageDescription</key>"))
        #expect(plist.contains("<key>NSContactsUsageDescription</key>"))
    }

    @Test func codesignEntitlementsIncludeCalendarReminderAndContacts() throws {
        let root = try self.repoRoot()
        let scriptPath = root.appendingPathComponent("scripts/codesign-mac-app.sh")
        let script = try String(contentsOf: scriptPath, encoding: .utf8)

        #expect(script.contains("<key>com.apple.security.personal-information.calendars</key>"))
        #expect(script.contains("<key>com.apple.security.personal-information.reminders</key>"))
        #expect(script.contains("<key>com.apple.security.personal-information.addressbook</key>"))
    }
}
