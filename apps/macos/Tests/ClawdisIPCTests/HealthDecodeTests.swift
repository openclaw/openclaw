import Foundation
import Testing
@testable import Clawdis

@Suite struct HealthDecodeTests {
    private let sampleJSON: String = {
        // minimal but complete payload
        """
        {"ts":1733622000,"durationMs":420,"web":{"linked":true,"authAgeMs":120000,"connect":{"ok":true,"status":200,"error":null,"elapsedMs":800}},"heartbeatSeconds":60,"sessions":{"path":"/tmp/sessions.json","count":1,"recent":[{"key":"abc","updatedAt":1733621900,"age":120000}]},"ipc":{"path":"/tmp/ipc.sock","exists":true}}
        """
    }()

    @Test func decodesCleanJSON() async throws {
        let data = Data(sampleJSON.utf8)
        let snap = decodeHealthSnapshot(from: data)

        #expect(snap?.web.linked == true)
        #expect(snap?.sessions.count == 1)
        #expect(snap?.ipc.exists == true)
    }

    @Test func decodesWithLeadingNoise() async throws {
        let noisy = "debug: something logged\n" + sampleJSON + "\ntrailer"
        let snap = decodeHealthSnapshot(from: Data(noisy.utf8))

        #expect(snap?.web.connect?.status == 200)
    }

    @Test func failsWithoutBraces() async throws {
        let data = Data("no json here".utf8)
        let snap = decodeHealthSnapshot(from: data)

        #expect(snap == nil)
    }
}
