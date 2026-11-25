import Foundation
import Network
import OpenClawKit

final class NetworkStatusService: Sendable {
    func currentStatus(timeoutMs: Int = 1500) async throws -> OpenClawNetworkStatusPayload {
        guard timeoutMs > 0 else { throw URLError(.timedOut) }

        return try await AsyncTimeout.withTimeoutMs(
            timeoutMs: timeoutMs,
            onTimeout: { URLError(.timedOut) },
            operation: {
                let monitor = NWPathMonitor()
                defer { monitor.cancel() }
                var iterator = monitor.makeAsyncIterator()
                guard let path = await iterator.next() else { throw URLError(.timedOut) }
                return Self.payload(from: path)
            })
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
