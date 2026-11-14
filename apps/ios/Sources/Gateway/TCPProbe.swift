import Foundation
import Network
import os

enum TCPProbe {
    static func probe(
        host: String,
        port: Int,
        timeoutSeconds: Double,
        queueLabel: String) async -> GatewayTCPProbeResult
    {
        guard port >= 1, port <= 65535 else { return .unreachable }
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return .unreachable }

        let endpointHost = NWEndpoint.Host(host)
        let connection = NWConnection(host: endpointHost, port: nwPort, using: .tcp)

        return await withCheckedContinuation { cont in
            let queue = DispatchQueue(label: queueLabel)
            let finished = OSAllocatedUnfairLock(initialState: false)
            let finish: @Sendable (GatewayTCPProbeResult) -> Void = { result in
                let shouldResume = finished.withLock { flag -> Bool in
                    if flag { return false }
                    flag = true
                    return true
                }
                guard shouldResume else { return }
                connection.cancel()
                cont.resume(returning: result)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(.reachable)
                // Network reports a reset as `.waiting` and would retry until the timeout.
                case let .waiting(error), let .failed(error):
                    if case .posix(.ECONNREFUSED) = error {
                        finish(.refused)
                    } else if case .failed = state {
                        finish(.unreachable)
                    }
                case .cancelled:
                    finish(.unreachable)
                default:
                    break
                }
            }

            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + timeoutSeconds) { finish(.unreachable) }
        }
    }
}
