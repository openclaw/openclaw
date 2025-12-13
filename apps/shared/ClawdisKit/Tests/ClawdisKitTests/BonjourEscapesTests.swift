import ClawdisKit
import XCTest

final class BonjourEscapesTests: XCTestCase {
    func testDecodePassThrough() {
        XCTAssertEqual(BonjourEscapes.decode("hello"), "hello")
        XCTAssertEqual(BonjourEscapes.decode(""), "")
    }

    func testDecodeSpaces() {
        XCTAssertEqual(BonjourEscapes.decode("Clawdis\\032Gateway"), "Clawdis Gateway")
    }

    func testDecodeMultipleEscapes() {
        XCTAssertEqual(
            BonjourEscapes.decode("A\\038B\\047C\\032D"),
            "A&B/C D")
    }

    func testDecodeIgnoresInvalidEscapeSequences() {
        XCTAssertEqual(BonjourEscapes.decode("Hello\\03World"), "Hello\\03World")
        XCTAssertEqual(BonjourEscapes.decode("Hello\\XYZWorld"), "Hello\\XYZWorld")
    }

    func testDecodeUsesDecimalUnicodeScalarValue() {
        XCTAssertEqual(BonjourEscapes.decode("Hello\\065World"), "HelloAWorld")
    }
}
