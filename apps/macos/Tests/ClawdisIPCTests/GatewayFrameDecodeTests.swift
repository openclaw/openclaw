import Foundation
import Testing
import ClawdisProtocol

@Suite struct GatewayFrameDecodeTests {
    @Test func decodesEventFrameWithAnyCodablePayload() throws {
        let json = """
        {
          "type": "event",
          "event": "presence",
          "payload": { "foo": "bar", "count": 1 },
          "seq": 7
        }
        """

        let frame = try JSONDecoder().decode(GatewayFrame.self, from: Data(json.utf8))

        #expect({
            if case .event = frame { true } else { false }
        }(), "expected .event frame")

        guard case let .event(evt) = frame else {
            return
        }

        let payload = evt.payload?.value as? [String: AnyCodable]
        #expect(payload?["foo"]?.value as? String == "bar")
        #expect(payload?["count"]?.value as? Int == 1)
        #expect(evt.seq == 7)
    }
}
