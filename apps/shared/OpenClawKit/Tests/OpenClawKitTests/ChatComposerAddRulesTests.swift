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

    func testConnectorTitleReadsTheServerNameAsAName() {
        func title(_ name: String) -> String {
            OpenClawChatComposerConnector(name: name, baseEnabled: true, tools: []).title
        }
        XCTAssertEqual(title("mobbin"), "Mobbin")
        XCTAssertEqual(title("google-drive"), "Google Drive")
        XCTAssertEqual(title("my_notes"), "My Notes")
        XCTAssertEqual(title("GitHub"), "GitHub")
    }

    func testToolDescriptionShowsItsFirstSentenceWhole() {
        func summary(_ text: String) -> String {
            OpenClawChatComposerTool.firstSentence(of: text)
        }
        XCTAssertEqual(
            summary("Search Mobbin for multi-step user flows (e.g. onboarding, checkout) using natural language. "
                + "Returns evenly-spaced preview images inline along with metadata for each flow."),
            "Search Mobbin for multi-step user flows (e.g. onboarding, checkout) using natural language.")
        XCTAssertEqual(
            summary("Search Mobbin for UI screens using natural language. Returns matching screens with inline "
                + "images and metadata. When you present results to the user, ALWAYS cite each screen."),
            "Search Mobbin for UI screens using natural language.")
        XCTAssertEqual(
            summary("Search Mobbin for website sections (e.g. About, Pricing, Footer) using natural language. "
                + "Returns section images inline along with metadata."),
            "Search Mobbin for website sections (e.g. About, Pricing, Footer) using natural language.")
        XCTAssertEqual(
            summary("Compare files, i.e. two versions, vs. the base etc. on macOS 14.2 at 1.5x speed. Then more."),
            "Compare files, i.e. two versions, vs. the base etc. on macOS 14.2 at 1.5x speed.")
        XCTAssertEqual(summary("Find code across repositories"), "Find code across repositories")
        XCTAssertEqual(summary("Is it ready? Check first."), "Is it ready?")
        XCTAssertEqual(summary("  "), "")
        XCTAssertEqual(summary(""), "")
    }
}
