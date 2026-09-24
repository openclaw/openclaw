import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

private actor RealtimeTalkEventIterator {
    private var iterator: AsyncStream<GatewayConnection.PushDelivery>.Iterator?

    init(stream: AsyncStream<GatewayConnection.PushDelivery>) {
        self.iterator = stream.makeAsyncIterator()
    }

    func next() async -> EventFrame? {
        guard var iterator = self.iterator else {
            preconditionFailure("Concurrent AsyncStream iteration is unsupported")
        }
        self.iterator = nil
        defer { self.iterator = iterator }
        guard !Task.isCancelled else { return nil }
        while let delivery = await iterator.next(isolation: self) {
            guard !Task.isCancelled else { return nil }
            guard delivery.isCurrent, case let .event(event)? = delivery.push else { continue }
            return event
        }
        return nil
    }
}

extension GatewayConnection {
    // MARK: - VoiceWake

    func voiceWakeSetTriggers(_ triggers: [String]) async {
        do {
            try await self.requestVoid(
                method: .voicewakeSet,
                params: ["triggers": AnyCodable(triggers)],
                timeoutMs: 10000)
        } catch {
            // Best-effort only.
        }
    }

    func talkMode(enabled: Bool, phase: String? = nil) async {
        var params: [String: AnyCodable] = ["enabled": AnyCodable(enabled)]
        if let phase {
            params["phase"] = AnyCodable(phase)
        }
        // Phase broadcasts report UI state; a failed notification must not start
        // the Gateway or restart its tunnel. Talk startup owns that recovery.
        _ = try? await self.request(method: Method.talkMode.rawValue, params: params, retryTransportFailures: false)
    }

    struct RealtimeTalkBootstrap: @unchecked Sendable {
        let transport: RealtimeTalkRelayTransport
        let configSnapshot: ConfigSnapshot
        let sessionKey: String
    }

    /// Freezes config and relay traffic to one physical Gateway socket.
    ///
    /// A route replacement between config resolution and session creation must
    /// fail this attempt instead of silently moving the relay to a new owner.
    func acquireRealtimeTalkBootstrap() async throws -> RealtimeTalkBootstrap {
        let lease = try await self.acquireServerLease()
        let data = try await self.request(
            method: Method.talkConfig.rawValue,
            params: [:],
            timeoutMs: 8000,
            ifCurrentServerLease: lease)
        let snapshot = try JSONDecoder().decode(ConfigSnapshot.self, from: data)
        guard await self.isCurrentServerLease(lease) else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let configuredSessionKey = snapshot.config?["session"]?.dictionaryValue?["mainKey"]?
            .stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        return RealtimeTalkBootstrap(
            transport: self.realtimeTalkTransport(ifCurrentServerLease: lease),
            configSnapshot: snapshot,
            sessionKey: configuredSessionKey?.isEmpty == false ? configuredSessionKey! : "main")
    }

    /// Creates a realtime Talk transport bound to one physical Gateway socket.
    ///
    /// Gateway relay sessions are owned by the connection that created them. A
    /// route-only transport could silently move follow-up audio or close calls to
    /// a replacement socket after reconnecting, where that session does not exist.
    func acquireRealtimeTalkTransport() async throws -> RealtimeTalkRelayTransport {
        let lease = try await self.acquireServerLease()
        return self.realtimeTalkTransport(ifCurrentServerLease: lease)
    }

    private func realtimeTalkTransport(
        ifCurrentServerLease lease: ServerLease) -> RealtimeTalkRelayTransport
    {
        RealtimeTalkRelayTransport(
            subscribeServerEvents: { bufferingNewest in
                let subscription = await self.makeRealtimeTalkSubscription(
                    bufferingNewest: bufferingNewest,
                    ifCurrentServerLease: lease)
                let iterator = RealtimeTalkEventIterator(stream: subscription.stream)
                // Pull directly from the owning queue; prefetching adds another buffer and stale frames.
                return AsyncStream(
                    unfolding: { await iterator.next() },
                    onCancel: { [continuation = subscription.continuation] in
                        continuation.finish()
                    })
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

    private func makeRealtimeTalkSubscription(
        bufferingNewest: Int,
        ifCurrentServerLease lease: ServerLease)
        -> (stream: AsyncStream<PushDelivery>, continuation: AsyncStream<PushDelivery>.Continuation)
    {
        let id = UUID()
        let connection = self
        let subscription = AsyncStream<PushDelivery>.makeStream(bufferingPolicy: .bufferingNewest(bufferingNewest))
        let continuation = subscription.continuation
        guard self.serverLeaseMatchesCurrentState(lease) else {
            continuation.finish()
            return subscription
        }
        self.realtimeTalkSubscribers[lease.socketGeneration, default: [:]][id] = continuation
        continuation.onTermination = { @Sendable _ in
            Task {
                await connection.removeRealtimeTalkSubscriber(
                    id,
                    socketGeneration: lease.socketGeneration)
            }
        }
        return subscription
    }

    func removeRealtimeTalkSubscriber(_ id: UUID, socketGeneration: UInt64) {
        self.realtimeTalkSubscribers[socketGeneration]?[id] = nil
        if self.realtimeTalkSubscribers[socketGeneration]?.isEmpty == true {
            self.realtimeTalkSubscribers[socketGeneration] = nil
        }
    }

    func finishRealtimeTalkSubscribers(socketGeneration: UInt64? = nil) {
        let subscribers: [AsyncStream<PushDelivery>.Continuation]
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
        self.socketGenerationState.activeGeneration
    }
    #endif
}
