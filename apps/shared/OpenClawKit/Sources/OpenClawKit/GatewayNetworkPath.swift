import Foundation
import Synchronization
#if os(iOS) || os(macOS)
import Network
#endif

struct GatewayNetworkPath: Equatable, Sendable {
    let isSatisfied: Bool
    let interfaces: [String]
}

struct GatewayNetworkPathTracker {
    private var observed: GatewayNetworkPath?
    private var settled: GatewayNetworkPath?

    var needsSettle: Bool {
        self.observed != self.settled
    }

    mutating func observe(_ path: GatewayNetworkPath) -> Bool {
        guard path != self.observed else { return false }
        let initial = self.observed == nil
        self.observed = path
        // The first delivery describes the current network, not a network change.
        if initial { self.settled = path }
        return !initial
    }

    mutating func settle(_ path: GatewayNetworkPath) -> Bool {
        guard self.observed == path else { return false }
        self.settled = path
        return true
    }
}

enum GatewayNetworkPathMonitor {
    static let systemUpdates: (@Sendable () -> AsyncStream<GatewayNetworkPath>)? = {
        #if os(iOS) || os(macOS)
        { Observer.shared.updates() }
        #else
        // Watch sockets use TN3135 audio-session networking, not path-driven recovery.
        nil
        #endif
    }()

    #if os(iOS) || os(macOS)
    private final class Observer: Sendable {
        static let shared = Observer()

        private struct State {
            var started = false
            var latest: GatewayNetworkPath?
            var subscribers: [UUID: AsyncStream<GatewayNetworkPath>.Continuation] = [:]
        }

        private let state = Mutex(State())
        private let monitor = NWPathMonitor()
        private let queue = DispatchQueue(label: "ai.openclaw.gateway.network-path")

        private init() {
            self.monitor.pathUpdateHandler = { [weak self] path in
                let update = GatewayNetworkPath(
                    isSatisfied: path.status == .satisfied,
                    interfaces: path.availableInterfaces.map(\.name))
                self?.state.withLock { state in
                    state.latest = update
                    for subscriber in state.subscribers.values {
                        subscriber.yield(update)
                    }
                }
            }
        }

        func updates() -> AsyncStream<GatewayNetworkPath> {
            let id = UUID()
            let (stream, continuation) = AsyncStream<GatewayNetworkPath>
                .makeStream(bufferingPolicy: .bufferingNewest(1))
            continuation.onTermination = { [weak self] _ in
                self?.state.withLock { _ = $0.subscribers.removeValue(forKey: id) }
            }
            self.state.withLock { state in
                state.subscribers[id] = continuation
                if let latest = state.latest { continuation.yield(latest) }
                if !state.started {
                    state.started = true
                    self.monitor.start(queue: self.queue)
                }
            }
            return stream
        }
    }
    #endif
}
