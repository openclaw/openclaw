import XCTest
@testable import OpenClawChatUI

final class ChatComposerAddRulesTests: XCTestCase {
    func testCornerTapsMarkInOrderAndUnmark() {
        var selection = ChatRecentPhotoSelection()
        selection.toggle("a")
        selection.toggle("b")
        selection.toggle("c")
        XCTAssertEqual(selection.marked, ["a", "b", "c"])
        XCTAssertEqual(selection.number(of: "b"), 2)
        selection.toggle("a")
        XCTAssertEqual(selection.marked, ["b", "c"])
        XCTAssertEqual(selection.number(of: "b"), 1)
        XCTAssertNil(selection.number(of: "a"))
    }

    func testPhotoTapAttachesMarkedPhotosAndThatOne() {
        var selection = ChatRecentPhotoSelection()
        XCTAssertEqual(selection.attaching("a"), ["a"])
        selection.toggle("b")
        selection.toggle("c")
        XCTAssertEqual(selection.attaching("a"), ["b", "c", "a"])
        // A tap on a photo that is already marked attaches the marked ones, without it twice.
        XCTAssertEqual(selection.attaching("c"), ["b", "c"])
    }

    func testSkillGoesInFrontOfTheDraftAndKeepsIt() {
        XCTAssertEqual(OpenClawChatViewModel.draft("", insertingCommand: "/github"), "/github ")
        XCTAssertEqual(
            OpenClawChatViewModel.draft("Which PRs touch the composer?", insertingCommand: "/github"),
            "/github Which PRs touch the composer?")
        XCTAssertEqual(
            OpenClawChatViewModel.draft("  first line\nsecond line\n", insertingCommand: "/notion"),
            "/notion first line\nsecond line\n")
    }

    func testSkillReplacesALeadingCommandOnly() {
        XCTAssertEqual(
            OpenClawChatViewModel.draft("/github list my PRs", insertingCommand: "/gh_issues"),
            "/gh_issues list my PRs")
        XCTAssertEqual(OpenClawChatViewModel.draft("/github", insertingCommand: "/notion"), "/notion ")
        // A path or a doubled slash is text, not a command.
        XCTAssertEqual(
            OpenClawChatViewModel.draft("//not a command", insertingCommand: "/notion"),
            "/notion //not a command")
    }
}
