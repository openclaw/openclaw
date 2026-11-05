import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

struct GatewayPresenceProjectionTests {
    @Test func `shared web and native presence stream preserves the roster`() throws {
        struct Step: Decodable {
            let name: String
            let payload: AnyCodable
            let expected: [AnyCodable]?
            let reconnect: Bool?
        }
        let fixture = try #require(Bundle.module.url(
            forResource: "presence-deltas", withExtension: "json", subdirectory: "Fixtures"))
        let steps = try JSONDecoder().decode([Step].self, from: Data(contentsOf: fixture))
        var projection = GatewayPresenceProjection()
        for step in steps {
            if step.reconnect == true { projection.reset() }
            let event = EventFrame(
                type: "event", event: "presence", payload: step.payload,
                seq: 7, stateversion: StateVersion(presence: 10, health: 2), recipientprofileid: "recipient")
            let result = projection.project(event)
            #expect(
                result?.payload?.dictionaryValue?["presence"]?.arrayValue == step.expected,
                Comment(rawValue: step.name))
            if result != nil {
                #expect(result?.seq == event.seq)
                #expect(result?.stateversion?.health == 2)
                #expect(result?.recipientprofileid == "recipient")
            }
        }
    }

    @Test func `released gateway snapshots still pass through`() {
        var projection = GatewayPresenceProjection()
        let event = EventFrame(type: "event", event: "presence", payload: AnyCodable([
            "presence": [["ts": 1, "connectionId": "legacy"]],
        ]))
        #expect(projection.project(event)?.payload == event.payload)
    }
}
