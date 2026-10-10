import Foundation
import Network
import OpenClawKit
import os

final class NetworkStatusService: Sendable {
    func currentStatus(timeoutMs: Int = 1500) async throws -> OpenClawNetworkStatusPayload {
        guard timeoutMs > 0 else { throw URLError(.timedOut) }

        return try await withCheckedThrowingContinuation { cont in
            let monitor = NWPathMonitor()
            let queue = DispatchQueue(label: "ai.openclawfoundation.app.network-status")
            let completed = OSAllocatedUnfairLock(initialState: false)

            monitor.pathUpdateHandler = { path in
                guard completed.withLock({ completed in
                    defer { completed = true }
                    return !completed
                }) else { return }
                monitor.cancel()
                cont.resume(returning: Self.payload(from: path))
            }

            monitor.start(queue: queue)

            queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
                guard completed.withLock({ completed in
                    defer { completed = true }
                    return !completed
                }) else { return }
                monitor.cancel()
                cont.resume(throwing: URLError(.timedOut))
            }
        }
    }

    private static func payload(from path: NWPath) -> OpenClawNetworkStatusPayload {
        let status: OpenClawNetworkPathStatus = switch path.status {
        case .satisfied: .satisfied
        case .requiresConnection: .requiresConnection
        case .unsatisfied: .unsatisfied
        @unknown default: .unsatisfied
        }

        var interfaces: [OpenClawNetworkInterfaceType] = []
        if path.usesInterfaceType(.wifi) { interfaces.append(.wifi) }
        if path.usesInterfaceType(.cellular) { interfaces.append(.cellular) }
        if path.usesInterfaceType(.wiredEthernet) { interfaces.append(.wired) }
        if interfaces.isEmpty { interfaces.append(.other) }

        return OpenClawNetworkStatusPayload(
            status: status,
            isExpensive: path.isExpensive,
            isConstrained: path.isConstrained,
            interfaces: interfaces)
    }
}
