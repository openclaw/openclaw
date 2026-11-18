import Foundation
import OpenClawIroh
import Testing

struct OpenClawIrohTests {
    /// Real SwiftPM link and UniFFI calls, using synthetic keys and loopback-only routing.
    @Test func `loopback streams and typed close`() async throws {
        let alpn = Data("openclaw/tunnel/1".utf8)
        let server = try await bind(
            secretKey: Data(
                repeating: 1,
                count: 32),
            relayUrl: nil,
            alpns: [alpn],
            ipTransports: true,
            keepAliveMs: 1000)
        do {
            let client = try await bind(
                secretKey: Data(
                    repeating: 2,
                    count: 32),
                relayUrl: nil,
                alpns: [],
                ipTransports: true,
                keepAliveMs: 1000)
            do {
                let addresses = try server.boundSockets().map { socket in
                    let port = try #require(socket.split(separator: ":").last)
                    return (socket.hasPrefix("[") ? "[::1]:" : "127.0.0.1:") + port
                }
                async let accepting = server.accept()
                let outgoing = try await client.connect(
                    endpointId: server.id(),
                    alpn: alpn,
                    relayUrl: nil,
                    directAddrs: addresses,
                    cancel: CancelToken())
                let accepted = try await accepting
                let incoming = try #require(accepted)
                #expect(outgoing.remoteId() == server.id())
                let local = try await outgoing.openBi()
                try await local.send.write(data: Data("hello".utf8))
                let peer = try await incoming.acceptBi()
                #expect(try await peer.recv.read(max: 5) == Data("hello".utf8))
                let canceledStreamWait = CancelToken()
                canceledStreamWait.cancel()
                await #expect(throws: IrohError.Cancelled) {
                    _ = try await outgoing.openBi(cancel: canceledStreamWait)
                }
                await #expect(throws: IrohError.Cancelled) {
                    _ = try await incoming.acceptBi(cancel: canceledStreamWait)
                }
                // Canceling a stream wait must preserve already-open streams.
                try await local.send.write(data: Data([7]))
                #expect(try await peer.recv.read(max: 1) == Data([7]))
                try await local.send.finish()
                #expect(try await peer.recv.read(max: 5) == nil)
                let code: Int64 = (1 << 61) + 7
                try incoming.close(code: code, reason: Data())
                let closed = await outgoing.closed()
                #expect(closed.kind == .application)
                #expect(closed.code == code)
                // A canceled token does not retire the shared endpoint.
                let canceled = CancelToken()
                canceled.cancel()
                await #expect(throws: IrohError.Cancelled) {
                    _ = try await client.connect(
                        endpointId: server.id(),
                        alpn: alpn,
                        relayUrl: nil,
                        directAddrs: addresses,
                        cancel: canceled)
                }
                async let acceptingAgain = server.accept()
                let again = try await client.connect(
                    endpointId: server.id(),
                    alpn: alpn,
                    relayUrl: nil,
                    directAddrs: addresses,
                    cancel: CancelToken())
                let next = try await acceptingAgain
                let acceptedAgain = try #require(next)
                try again.close(code: 0, reason: Data())
                _ = await acceptedAgain.closed()
            } catch {
                await client.shutdown()
                throw error
            }
            await client.shutdown()
        } catch {
            await server.shutdown()
            throw error
        }
        await server.shutdown()
    }
}
