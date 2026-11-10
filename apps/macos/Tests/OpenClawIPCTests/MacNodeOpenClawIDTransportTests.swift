import Foundation
import OpenClawKit
import Synchronization
import Testing
@testable import OpenClaw

struct MacNodeOpenClawIDTransportTests {
    @Test
    func `verified relay change retires the old route before dialing and permits a replacement`() async throws {
        let oldRelay = try #require(URL(string: "https://relay-a.example.invalid/"))
        let newRelay = try #require(URL(string: "https://relay-b.example.invalid/"))
        let target = Mutex((serverKey: "server-a", relayURL: oldRelay))
        let invalidations = Mutex(0)
        let endpoint = RecordingEndpoint()
        let tunnel = MacNodeOpenClawIDTransport.makeTunnel(
            endpoint: endpoint,
            relayURL: oldRelay,
            verifiedTarget: { target.withLock { $0 } },
            onInvalidated: { invalidations.withLock { $0 += 1 } })
        await #expect(throws: DialObserved.self) { _ = try await tunnel.openStream() }
        #expect(invalidations.withLock { $0 } == 0)

        target.withLock { $0 = ("server-b", newRelay) }
        await #expect(throws: OpenClawIDNodeTransportError.closed) { _ = try await tunnel.openStream() }
        #expect(invalidations.withLock { $0 } == 1)
        #expect(await endpoint.relays == [oldRelay])
        #expect(await endpoint.keys == ["server-a"])
        await tunnel.shutdown()
        #expect(await endpoint.stopped)

        let replacementEndpoint = RecordingEndpoint()
        let replacement = MacNodeOpenClawIDTransport.makeTunnel(
            endpoint: replacementEndpoint,
            relayURL: newRelay,
            verifiedTarget: { target.withLock { $0 } },
            onInvalidated: { invalidations.withLock { $0 += 1 } })
        await #expect(throws: DialObserved.self) { _ = try await replacement.openStream() }
        #expect(await replacementEndpoint.relays == [newRelay])
        #expect(await replacementEndpoint.keys == ["server-b"])
        #expect(invalidations.withLock { $0 } == 1)
        await replacement.shutdown()
    }
}

private enum DialObserved: Error { case reached }

private actor RecordingEndpoint: OpenClawIDNodeEndpoint {
    var relays: [URL] = []
    var keys: [String] = []
    var stopped = false

    func connect(serverKey: String, relayURL: URL, alpn: Data) async throws -> any OpenClawIDNodeConnection {
        self.relays.append(relayURL)
        self.keys.append(serverKey)
        throw DialObserved.reached
    }

    func relayStatus() async -> [OpenClawIDNodeRelayStatus] {
        []
    }

    func shutdown() async {
        self.stopped = true
    }
}
