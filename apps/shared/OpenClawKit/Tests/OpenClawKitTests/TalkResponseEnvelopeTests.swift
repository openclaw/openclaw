import XCTest
@testable import OpenClawKit

final class TalkResponseEnvelopeTests: XCTestCase {
    func testParsesWholeObjectResponse() {
        let result = TalkResponseEnvelopeParser.parse(
            #"{"response":"I will check that.","status":"working"}"#)

        XCTAssertTrue(result.isEnvelope)
        XCTAssertEqual(result.response, "I will check that.")
        XCTAssertEqual(result.keys, ["response", "status"])
    }

    func testParsesFirstLineObjectResponse() {
        let result = TalkResponseEnvelopeParser.parse(
            """
            {"response":"Done."}
            non-spoken diagnostic
            """)

        XCTAssertTrue(result.isEnvelope)
        XCTAssertEqual(result.response, "Done.")
    }

    func testParsesFencedObjectResponse() {
        let result = TalkResponseEnvelopeParser.parse(
            """
            ```json
            {"response":"Ready."}
            ```
            """)

        XCTAssertTrue(result.isEnvelope)
        XCTAssertEqual(result.response, "Ready.")
    }

    func testPlainTextIsNotEnvelope() {
        let result = TalkResponseEnvelopeParser.parse("Plain reply.")

        XCTAssertFalse(result.isEnvelope)
        XCTAssertNil(result.response)
    }

    func testEmptyResponseSuppressesSpeech() {
        let result = TalkResponseEnvelopeParser.parse(#"{"response":"   ","status":"queued"}"#)

        XCTAssertTrue(result.isEnvelope)
        XCTAssertNil(result.response)
    }
}
