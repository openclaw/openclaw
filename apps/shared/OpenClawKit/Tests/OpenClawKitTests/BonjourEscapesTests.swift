import OpenClawKit
import Testing

@Suite struct BonjourEscapesTests {
    @Test func decodePassThrough() {
        #expect(BonjourEscapes.decode("hello") == "hello")
        #expect(BonjourEscapes.decode("") == "")
    }

    @Test func decodeSpaces() {
        #expect(BonjourEscapes.decode("OpenClaw\\032Gateway") == "OpenClaw Gateway")
    }

    @Test func decodeMultipleEscapes() {
        #expect(BonjourEscapes.decode("A\\038B\\047C\\032D") == "A&B/C D")
    }

    @Test func decodeIgnoresInvalidEscapeSequences() {
        #expect(BonjourEscapes.decode("Hello\\03World") == "Hello\\03World")
        #expect(BonjourEscapes.decode("Hello\\XYZWorld") == "Hello\\XYZWorld")
    }

    @Test func decodeUsesDecimalUnicodeScalarValue() {
        #expect(BonjourEscapes.decode("Hello\\065World") == "HelloAWorld")
    }

    // DNS-SD escapes are octets, so multi-byte characters arrive as several escapes.
    @Test func decodeUTF8ByteEscapes() {
        #expect(BonjourEscapes.decode("Bobby\\226\\128\\153s Mac") == "Bobby\u{2019}s Mac")
    }

    @Test func decodeKeepsOutOfRangeEscapesLiteral() {
        #expect(BonjourEscapes.decode("a\\999b") == "a\\999b")
    }

    @Test func decodePreservesUnescapedNonASCII() {
        #expect(BonjourEscapes.decode("Caf\u{00E9}\\032Bar") == "Caf\u{00E9} Bar")
    }
}
