import CoreText
import Foundation
import Testing
import UIKit
@testable import OpenClaw

struct OpenClawTypographyTests {
    @Test func `bundled fonts load from app bundle`() {
        for name in OpenClawType.registeredPostScriptNames {
            #expect(UIFont(name: name, size: 12) != nil, "Missing bundled font: \(name)")
        }
    }

    @Test func `dynamic type scales display fonts`() {
        guard let base = UIFont(name: "RedHatDisplay-Regular", size: 34) else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let defaultTraits = UITraitCollection(preferredContentSizeCategory: .large)
        let largeTraits = UITraitCollection(preferredContentSizeCategory: .accessibilityExtraExtraExtraLarge)
        let metrics = UIFontMetrics(forTextStyle: .largeTitle)

        let defaultSize = metrics.scaledFont(for: base, compatibleWith: defaultTraits).pointSize
        let largeSize = metrics.scaledFont(for: base, compatibleWith: largeTraits).pointSize

        #expect(largeSize > defaultSize)
    }

    @Test func `display variable weight axis instantiates heavy weights`() {
        guard UIFont(name: "RedHatDisplay-Regular", size: 15) != nil else {
            Issue.record("RedHatDisplay-Regular should be bundled")
            return
        }

        let weightAxis = NSNumber(value: 2_003_265_652) // "wght"
        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: "RedHatDisplay-Regular",
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [weightAxis: 900],
        ])
        let font = UIFont(descriptor: descriptor, size: 15)
        let variations = font.fontDescriptor.object(
            forKey: kCTFontVariationAttribute as UIFontDescriptor.AttributeName) as? [NSNumber: Any]
        let weightValue = variations?[weightAxis] as? NSNumber

        #expect(weightValue?.doubleValue == 900)
    }

    @Test func `app extensions register bundled branded fonts`() throws {
        let project = try String(contentsOf: Self.projectYmlURL(), encoding: .utf8)
        let activityPlist = try String(contentsOf: Self.activityWidgetInfoPlistURL(), encoding: .utf8)
        let watchPlist = try String(contentsOf: Self.watchInfoPlistURL(), encoding: .utf8)

        for targetName in ["OpenClawActivityWidget", "OpenClawWatchApp"] {
            let target = try Self.extract(
                project,
                from: "  \(targetName):",
                to: targetName == "OpenClawActivityWidget" ? "  OpenClawWatchApp:" : "  OpenClawTests:")
            #expect(target.contains("- path: Sources/Fonts"))
            #expect(target.contains("UIAppFonts:"))
            for font in Self.bundledFontFiles {
                #expect(target.contains("- \(font)"))
            }
        }

        for plist in [activityPlist, watchPlist] {
            #expect(plist.contains("<key>UIAppFonts</key>"))
            for font in Self.bundledFontFiles {
                #expect(plist.contains("<string>\(font)</string>"))
            }
        }
    }

    @Test func `extension text surfaces use branded typography helpers`() throws {
        let activitySource = try String(contentsOf: Self.activityWidgetSourceURL(), encoding: .utf8)
        let watchSource = try String(contentsOf: Self.watchInboxSourceURL(), encoding: .utf8)

        #expect(activitySource.contains("OpenClawActivityType.subheadSemiBold"))
        #expect(activitySource.contains("OpenClawActivityType.subheadBold"))
        #expect(activitySource.contains("OpenClawActivityType.caption"))
        #expect(!activitySource.contains(".font(.subheadline"))
        #expect(!activitySource.contains(".font(.caption"))

        #expect(watchSource.contains("WatchClawType.title"))
        #expect(watchSource.contains("WatchClawType.body"))
        #expect(watchSource.contains("WatchClawType.caption"))
        #expect(!watchSource.contains(".font(.system"))
        #expect(!watchSource.contains(".font(.caption"))
        #expect(!watchSource.contains(".font(.title"))
    }

    @Test func `listed iOS app surfaces enforce branded control typography`() throws {
        let proComponents = try String(
            contentsOf: Self.sourceURL("Design/OpenClawProComponents.swift"),
            encoding: .utf8)
        let quickSetup = try String(contentsOf: Self.sourceURL("Gateway/GatewayQuickSetupSheet.swift"), encoding: .utf8)
        let settingsSections = try String(
            contentsOf: Self.sourceURL("Design/SettingsProTabSections.swift"),
            encoding: .utf8)
        let privacyAccess = try String(
            contentsOf: Self.sourceURL("Settings/PrivacyAccessSectionView.swift"),
            encoding: .utf8)
        let skillWorkshop = try String(
            contentsOf: Self.sourceURL("Design/IPadSkillWorkshopScreen.swift"),
            encoding: .utf8)
        let agentDestinations = try String(
            contentsOf: Self.sourceURL("Design/AgentProTab+Destinations.swift"),
            encoding: .utf8)
        let dreaming = try String(
            contentsOf: Self.sourceURL("Design/AgentProDreamingDestination.swift"),
            encoding: .utf8)
        let instances = try String(contentsOf: Self.sourceURL("Design/AgentProNodesDestination.swift"), encoding: .utf8)
        let channels = try String(
            contentsOf: Self.sourceURL("Design/SettingsChannelsDestination.swift"),
            encoding: .utf8)
        let docs = try String(contentsOf: Self.sourceURL("Design/OpenClawDocsScreen.swift"), encoding: .utf8)

        #expect(proComponents.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(proComponents.contains("Text(primaryActionTitle)"))
        #expect(proComponents.contains("Text(secondaryActionTitle)"))

        #expect(!quickSetup.contains("Button(\"Close\")"))
        #expect(quickSetup.contains("Text(\"Close\")"))
        #expect(quickSetup.contains(".font(OpenClawType.subheadSemiBold)"))

        #expect(settingsSections.contains(".font(OpenClawType.body)"))
        #expect(settingsSections.contains("Toggle(isOn: self.$talkButtonEnabled)"))
        #expect(settingsSections.contains("Text(\"Show Talk Control\")"))
        #expect(settingsSections.contains("TextField(\"Default Share Instruction\""))
        #expect(settingsSections.contains(".font(OpenClawType.subhead)"))

        #expect(!privacyAccess.contains("DisclosureGroup(\"Privacy & Access\")"))
        #expect(privacyAccess.contains("Text(\"Privacy & Access\")"))
        #expect(privacyAccess.contains("Text(actionTitle)"))
        #expect(privacyAccess.contains(".font(OpenClawType.footnoteSemiBold)"))

        #expect(!skillWorkshop.contains("Button(\"Done\")"))
        #expect(skillWorkshop.contains("Label(\"Refresh\", systemImage: \"arrow.clockwise\")"))
        #expect(skillWorkshop.contains("Text(\"Default agent\")"))
        #expect(skillWorkshop.contains("Text(\"Inspect\")"))
        #expect(skillWorkshop.contains("Text(\"Apply\")"))
        #expect(skillWorkshop.contains("Text(\"Reject\")"))

        for source in [agentDestinations, dreaming, instances, channels, docs] {
            #expect(source.contains(".font(OpenClawType.body)"))
        }
    }

    private static let bundledFontFiles = [
        "RedHatDisplay[wght].ttf",
        "Inter[opsz,wght].ttf",
        "Inter-Italic[opsz,wght].ttf",
        "JetBrainsMono-Regular.ttf",
        "JetBrainsMono-Medium.ttf",
        "JetBrainsMono-SemiBold.ttf",
    ]

    private static func projectYmlURL() -> URL {
        self.iosRootURL().appendingPathComponent("project.yml")
    }

    private static func activityWidgetInfoPlistURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/Info.plist")
    }

    private static func watchInfoPlistURL() -> URL {
        self.iosRootURL().appendingPathComponent("WatchApp/Info.plist")
    }

    private static func activityWidgetSourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("ActivityWidget/OpenClawLiveActivity.swift")
    }

    private static func watchInboxSourceURL() -> URL {
        self.iosRootURL().appendingPathComponent("WatchApp/Sources/WatchInboxView.swift")
    }

    private static func sourceURL(_ relativePath: String) -> URL {
        self.iosRootURL().appendingPathComponent("Sources/\(relativePath)")
    }

    private static func iosRootURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
