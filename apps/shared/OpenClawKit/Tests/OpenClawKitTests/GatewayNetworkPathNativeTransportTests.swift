#if os(macOS) || os(iOS)
import Foundation
import Testing
@testable import OpenClawKit

extension GatewayChannelActor {
    fileprivate func configureNativePathRecovery(
        observed: @escaping @Sendable (GatewayNetworkPath) -> Void)
    {
        self.networkPathSettleDuration = .zero
        self.networkPathProbeTimeout = .milliseconds(50)
        self.testNetworkPathObserved = observed
    }
}

struct GatewayNetworkPathNativeTransportTests {
    @Test
    func `stalled URL session socket reconnects after path change`() async throws {
        let fixture = try await NativeGatewayWebSocketFixture.start(issuedDeviceTokens: [nil, nil])
        defer { fixture.stop() }
        let paths = AsyncStream<GatewayNetworkPath>.makeStream()
        let observed = AsyncStream<GatewayNetworkPath>.makeStream()
        let snapshots = AsyncStream<UInt64>.makeStream()
        var observations = observed.stream.makeAsyncIterator()
        var connections = snapshots.stream.makeAsyncIterator()
        let channel = GatewayChannelActor(
            url: fixture.url(),
            token: nil,
            pushHandler: { push, generation in
                if case .snapshot = push { snapshots.continuation.yield(generation) }
            },
            connectOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "native-path-test", clientMode: "node", clientDisplayName: "Path Recovery Test",
                includeDeviceIdentity: false),
            networkPathUpdates: { paths.stream })
        await channel.configureNativePathRecovery(observed: { observed.continuation.yield($0) })
        defer {
            paths.continuation.finish()
            observed.continuation.finish()
            snapshots.continuation.finish()
        }
        do {
            paths.continuation.yield(.init(isSatisfied: true, interfaces: ["fixture-a"]))
            _ = await observations.next()
            try await channel.connect()
            let first = try #require(await connections.next())
            #expect(fixture.capturedAuth(at: 0) != nil)
            fixture.stallConnection(at: 0)
            paths.continuation.yield(.init(isSatisfied: true, interfaces: ["fixture-b"]))
            let second = try #require(await connections.next())
            #expect(second != first)
            // The fixture records auth only after decoding the actual Gateway connect frame.
            #expect(fixture.capturedAuth(at: 1) != nil)
            #expect(await channel.currentConnectionGeneration() == second)
        } catch {
            await channel.shutdown()
            throw error
        }
        await channel.shutdown()
    }
}
#endif
