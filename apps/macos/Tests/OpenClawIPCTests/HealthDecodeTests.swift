import Foundation
import Testing
@testable import OpenClaw

struct HealthDecodeTests {
    private let sampleJSON: String = // minimal but complete payload
        """
        {"ts":1733622000,"durationMs":420,"channels":{"whatsapp":{"linked":true,"authAgeMs":120000},"telegram":{"configured":true,"probe":{"ok":true,"elapsedMs":800}}},"channelOrder":["whatsapp","telegram"],"heartbeatSeconds":60,"sessions":{"path":"/tmp/sessions.json","count":1,"recent":[{"key":"abc","updatedAt":1733621900,"age":120000}]}}
        """

    @Test func `decodes clean JSON`() {
        let data = Data(sampleJSON.utf8)
        let snap = decodeHealthSnapshot(from: data)

        #expect(snap?.channels["whatsapp"]?.linked == true)
        #expect(snap?.channels["telegram"]?.probe?.elapsedMs == 800)
        #expect(snap?.sessions.count == 1)
    }

    @Test(arguments: ["no json here", "{", "}", "} diagnostic {"])
    func `rejects output without a JSON object`(_ output: String) {
        #expect(decodeHealthSnapshot(from: Data(output.utf8)) == nil)
    }
}
