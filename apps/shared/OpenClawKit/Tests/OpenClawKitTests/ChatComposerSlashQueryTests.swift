import XCTest
@testable import OpenClawChatUI

final class ChatComposerSlashQueryTests: XCTestCase {
    func testPanelCompletesTheNameBeingTyped() {
        XCTAssertEqual(OpenClawChatComposer.slashQuery(forDraft: "/"), "")
        XCTAssertEqual(OpenClawChatComposer.slashQuery(forDraft: "/emil"), "emil")
        XCTAssertEqual(OpenClawChatComposer.slashQuery(forDraft: "  /emil_design_eng"), "emil_design_eng")
    }

    func testSpaceAfterTheNameClosesThePanel() {
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "/emil_design_eng "))
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "/release check this"))
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "/new\n"))
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "/ "))
    }

    func testSkillKeepsThePanelForItsArgument() {
        XCTAssertEqual(OpenClawChatComposer.slashQuery(forDraft: "/skill"), "skill")
        XCTAssertEqual(OpenClawChatComposer.slashQuery(forDraft: "/skill "), "skill ")
        XCTAssertEqual(OpenClawChatComposer.slashQuery(forDraft: "/skill git"), "skill git")
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "/skill github "))
    }

    func testOtherTextHasNoPanel() {
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "hello /emil"))
        XCTAssertNil(OpenClawChatComposer.slashQuery(forDraft: "//not a command"))
    }
}
