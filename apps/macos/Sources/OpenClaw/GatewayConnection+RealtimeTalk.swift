import Foundation
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    /// Creates a realtime Talk transport bound to one physical Gateway socket.
    ///
    /// Gateway relay sessions are owned by the connection that created them. A
    /// route-only transport could silently move follow-up audio or close calls to
    /// a replacement socket after reconnecting, where that session does not exist.
    func acquireRealtimeTalkTransport() async throws -> RealtimeTalkRelayTransport {
        let lease = try await self.acquireServerLease()

        return RealtimeTalkRelayTransport(
            subscribeServerEvents: { bufferingNewest in
                let pushes = await self.subscribe(
                    bufferingNewest: bufferingNewest,
                    ifCurrentServerLease: lease)
                return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
                    let task = Task {
                        for await push in pushes {
                            guard case let .event(event) = push else { continue }
                            continuation.yield(event)
                        }
                        continuation.finish()
                    }
                    continuation.onTermination = { @Sendable _ in
                        task.cancel()
                    }
                }
            },
            request: { method, params, timeoutMs in
                try await self.request(
                    method: method,
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentServerLease: lease)
            },
            isCurrent: {
                await self.isCurrentServerLease(lease)
            })
    }

    func subscribe(
        bufferingNewest: Int,
        ifCurrentServerLease lease: ServerLease) -> AsyncStream<GatewayPush>
    {
        let id = UUID()
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            guard self.serverLeaseMatchesCurrentState(lease) else {
                continuation.finish()
                return
            }
            if let snapshot = self.lastSnapshot {
                continuation.yield(.snapshot(snapshot))
            }
            self.realtimeTalkSubscribers[lease.socketGeneration, default: [:]][id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task {
                    await connection.removeRealtimeTalkSubscriber(
                        id,
                        socketGeneration: lease.socketGeneration)
                }
            }
        }
    }

    private func removeRealtimeTalkSubscriber(_ id: UUID, socketGeneration: UInt64) {
        self.realtimeTalkSubscribers[socketGeneration]?[id] = nil
        if self.realtimeTalkSubscribers[socketGeneration]?.isEmpty == true {
            self.realtimeTalkSubscribers[socketGeneration] = nil
        }
    }

    func finishRealtimeTalkSubscribers(socketGeneration: UInt64? = nil) {
        let subscribers: [AsyncStream<GatewayPush>.Continuation]
        if let socketGeneration {
            if let removed = self.realtimeTalkSubscribers.removeValue(forKey: socketGeneration) {
                subscribers = Array(removed.values)
            } else {
                subscribers = []
            }
        } else {
            subscribers = self.realtimeTalkSubscribers.values.flatMap(\.values)
            self.realtimeTalkSubscribers.removeAll()
        }
        subscribers.forEach { $0.finish() }
    }

    #if DEBUG
    func _test_activeSocketGeneration() -> UInt64? {
        self.activeSocketGeneration
    }
    #endif
}
