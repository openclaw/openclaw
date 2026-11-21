import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

/// Coverage for the fit decision the shared table takes from the width its reply actually has: the
/// reported iPhone case must bound its columns and wrap, and only a table that cannot keep its
/// columns readable may fall back to horizontal scrolling.
@MainActor
struct ChatMarkdownTableColumnWidthTests {
    /// What an iPhone 15 (390 pt) reply leaves for the table card once the chat's own margins and
    /// the bubble padding are taken off it.
    private static let compactCardWidth: CGFloat = 366
    /// A desktop reply width, where the same table has room for every column on one line.
    private static let wideCardWidth: CGFloat = 1200
    /// The column count of the table reported in the issue.
    private static let reportedColumns = 2

    @Test func `the reported table bounds its columns to the compact reply width`() {
        let columns = CGFloat(Self.reportedColumns)
        #expect(!ChatMarkdownTableView.overflowsReplyWidth(
            cardWidth: Self.compactCardWidth,
            columns: Self.reportedColumns))
        let width = ChatMarkdownTableView.sharedColumnWidth(
            cardWidth: Self.compactCardWidth,
            columns: Self.reportedColumns)
        // Both columns stay inside the card instead of one of them running off the screen: two
        // bounded columns plus the gap between them add up to the card's content width.
        let content = Self.compactCardWidth
            - (ChatMarkdownTableView.cardPadding * 2)
            - (ChatMarkdownTableView.columnSpacing * (columns - 1))
        #expect(abs((width * columns) - content) < 0.01)
        #expect(width >= ChatMarkdownTableView.minimumColumnWidth)
    }

    @Test func `a table that cannot keep readable columns scrolls at the minimum width`() {
        let columns = 6
        #expect(ChatMarkdownTableView.overflowsReplyWidth(
            cardWidth: Self.compactCardWidth,
            columns: columns))
        // Six equal columns would be far too narrow to read on a phone, so the table keeps the
        // readable minimum and becomes wider than the card, which is what makes it scroll.
        let shared = ChatMarkdownTableView.sharedColumnWidth(
            cardWidth: Self.compactCardWidth,
            columns: columns)
        #expect(shared < ChatMarkdownTableView.minimumColumnWidth)
        let scrolledWidth = (ChatMarkdownTableView.minimumColumnWidth * CGFloat(columns))
            + (ChatMarkdownTableView.columnSpacing * CGFloat(columns - 1))
        #expect(scrolledWidth > Self.compactCardWidth)
    }

    @Test func `a wide reply keeps every column bounded without scrolling`() {
        let columns = 6
        #expect(!ChatMarkdownTableView.overflowsReplyWidth(
            cardWidth: Self.wideCardWidth,
            columns: columns))
        let width = ChatMarkdownTableView.sharedColumnWidth(
            cardWidth: Self.wideCardWidth,
            columns: columns)
        #expect(width > ChatMarkdownTableView.minimumColumnWidth)
    }

    @Test func `an unmeasured reply width never reports overflow`() {
        // The card width arrives from the first layout pass; before that the table must not decide
        // that it needs a scroller.
        #expect(!ChatMarkdownTableView.overflowsReplyWidth(cardWidth: 0, columns: 6))
    }
}
