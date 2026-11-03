import Foundation
import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct NativeChatTextSizeTests {
    @Test func `native chat size survives a fresh preference owner without changing appearance`() throws {
        let suite = "NativeChatTextSizeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let appearance = AppAppearanceModel(userDefaults: defaults)
        #expect(appearance.chatTextSize == .standard)
        appearance.select(.dark, userDefaults: defaults)
        appearance.selectChatTextSize(.larger, userDefaults: defaults)

        let reloadedDefaults = try #require(UserDefaults(suiteName: suite))
        let reloaded = AppAppearanceModel(userDefaults: reloadedDefaults)
        #expect(reloaded.chatTextSize == .larger)
        #expect(reloaded.preference == .dark)
        reloaded.selectChatTextSize(.standard, userDefaults: reloadedDefaults)
        #expect(AppAppearanceModel(userDefaults: defaults).chatTextSize == .standard)
    }

    @Test(arguments: [
        DynamicTypeSize.accessibility1,
        .accessibility2,
        .accessibility3,
        .accessibility4,
        .accessibility5,
    ])
    func `system accessibility sizes take priority over local density`(_ systemSize: DynamicTypeSize) {
        for preference in NativeChatTextSize.allCases {
            #expect(preference.dynamicTypeSize(relativeTo: systemSize) == systemSize)
        }
    }
}
