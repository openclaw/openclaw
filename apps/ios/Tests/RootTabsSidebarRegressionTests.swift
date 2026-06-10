import Foundation
import Testing

@Suite struct RootTabsSidebarRegressionTests {
    @Test func iPadSplitHiddenSidebarUsesHeaderRevealInsteadOfReservedRail() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let navigationSource = try String(contentsOf: Self.rootTabsNavigationSourceURL(), encoding: .utf8)
        let splitContent = try Self.extract(
            source,
            from: "private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View",
            to: "private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View")

        #expect(splitContent.contains("HStack(spacing: 0)"))
        #expect(splitContent.contains("self.sidebarColumn"))
        #expect(splitContent.contains(".frame(width: sidebarWidth, alignment: .topLeading)"))
        #expect(splitContent.contains(".overlay(alignment: .trailing)"))
        #expect(!splitContent.contains("self.syncSidebarVisibility(from: visibility)"))
        #expect(!source.contains("NavigationSplitViewVisibility"))
        #expect(!source.contains("@State private var splitColumnVisibility: NavigationSplitViewVisibility"))
        #expect(!splitContent.contains("NavigationSplitView"))
        #expect(!splitContent.contains("self.collapsedSidebarRail"))
        #expect(!source.contains("private var collapsedSidebarRail: some View"))
        #expect(!source.contains("Self.sidebarCollapsedRailWidth"))
        #expect(source.contains("shouldShowSidebarRevealInDestinationHeader"))
        #expect(!navigationSource.contains("static let sidebarCollapsedRailWidth"))
        #expect(!navigationSource.contains("static func sidebarSplitColumnVisibility(isSidebarVisible: Bool)"))
        #expect(!navigationSource
            .contains("static func sidebarIsVisible(splitColumnVisibility: NavigationSplitViewVisibility)"))
    }

    @Test func initialSidebarVisibilitySurvivesFirstLayoutMeasurement() throws {
        let source = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)
        let layoutUpdate = try Self.extract(
            source,
            from: "private func updateSidebarLayout(containerSize: CGSize, force: Bool)",
            to: "private func setSidebarVisible(_ isVisible: Bool)")

        #expect(source.contains("@State private var didResolveSidebarLayout: Bool = false"))
        #expect(layoutUpdate.contains("let didResolvePreviousLayout = self.didResolveSidebarLayout"))
        #expect(layoutUpdate.contains("self.didResolveSidebarLayout = true"))
        #expect(layoutUpdate.contains("if layoutModeDidChange && didResolvePreviousLayout"))
        #expect(layoutUpdate.contains("guard force || !self.sidebarVisibilityUserOverridden else { return }"))
    }

    private static func rootTabsSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabs.swift")
    }

    private static func rootTabsNavigationSourceURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/RootTabsNavigation.swift")
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
