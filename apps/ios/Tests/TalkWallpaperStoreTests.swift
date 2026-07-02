import Foundation
import Testing
@testable import OpenClaw

struct TalkWallpaperStoreTests {
    @Test
    func selectionDefaultsToGray() {
        let suiteName = "TalkWallpaperStoreTests.selectionDefaultsToGray"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(TalkWallpaperStore.selection(defaults: defaults) == .default)
    }

    @Test
    func selectionFallsBackWhenCustomMissing() {
        let suiteName = "TalkWallpaperStoreTests.selectionFallsBackWhenCustomMissing"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        defer { defaults.removePersistentDomain(forName: suiteName) }

        TalkWallpaperStore.setSelection(.custom, defaults: defaults)
        #expect(TalkWallpaperStore.selection(defaults: defaults) == .default)
    }
}