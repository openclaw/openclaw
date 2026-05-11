import OpenClawKit
import Foundation
import Testing

@Suite struct CanvasScaffoldTests {
    @Test func defaultScaffoldPresentsCreativeControlRoomAnchors() throws {
        let url = try #require(OpenClawKitResources.bundle.url(
            forResource: "scaffold",
            withExtension: "html"))
        let html = try String(contentsOf: url, encoding: .utf8)

        #expect(html.contains("Thomas Workbench"))
        #expect(html.contains("openclaw-home-plan"))
        #expect(html.contains("openclaw-home-devices"))
        #expect(html.contains("openclaw-home-actions"))
        #expect(html.contains("openclaw-home-memory"))
        #expect(html.contains("openclaw-home-notion"))
        #expect(html.contains("openclaw-home-cron"))
        #expect(html.contains("Serious suggestion"))
        #expect(html.contains("Fun suggestion"))
        #expect(html.contains("openclaw-home-thomas"))
        #expect(html.contains("openclaw-home-thomas-stage"))
        #expect(html.contains("openclaw-home-insight-layer"))
        #expect(html.contains("thomas_avatar.png"))
        #expect(html.contains("thomas-avatar"))
        #expect(html.contains("studio-ribbon"))
        #expect(html.contains("burst-ripple"))
        #expect(html.contains("slot-reel"))
        #expect(html.contains("renderHome"))
        #expect(html.contains("renderThomas"))
        #expect(html.contains("renderInsight"))
        #expect(html.contains("animateSlotValue"))
        #expect(html.contains("openclaw-live-thomas-card"))
        #expect(html.contains("Live Thomas"))
        #expect(html.contains("openclaw-live-thomas-toggle"))
        #expect(html.contains("talk.realtime.toggle"))
        #expect(html.contains("openclaw:live-thomas-status"))
        #expect(html.contains("dedicated realtime bridge"))
        #expect(html.contains("Set up realtime"))
        #expect(html.contains("data-live-state=\"setup\""))
        #expect(!html.contains("Tap to wake the native Talk runtime"))
        #expect(!html.contains("fallback keeps the voice alive"))
        #expect(!html.contains("Try again"))

        let avatarURL = try #require(
            OpenClawKitResources.bundle.url(
                forResource: "thomas_avatar",
                withExtension: "png",
                subdirectory: "CanvasScaffold")
                ?? OpenClawKitResources.bundle.url(forResource: "thomas_avatar", withExtension: "png"))
        #expect(FileManager.default.fileExists(atPath: avatarURL.path))
    }
}
