import Darwin
import Foundation

/// Compile the actual tunnel manager with the SSH process replaced. Each double records whether it
/// opened the widget sandbox forward, the fact the manager's reuse decision must honor.
/// The app's Logger is swift-log with a privacy interpolation; logs are irrelevant here.
enum AppLogPrivacy { case `public` }

extension DefaultStringInterpolation {
    mutating func appendInterpolation(_ value: some CustomStringConvertible, privacy _: AppLogPrivacy) {
        self.appendInterpolation(value.description)
    }
}

struct Logger: Sendable {
    init(subsystem _: String, category _: String) {}
    func info(_: @autoclosure () -> String) {}
    func error(_: @autoclosure () -> String) {}
}

nonisolated(unsafe) var sandboxPortAvailable = false
nonisolated(unsafe) var createdTunnels: [RemotePortTunnel] = []

final class RemotePortTunnel: @unchecked Sendable {
    struct Configuration: Equatable, Sendable {
        let remotePort: Int
    }

    let localPort: UInt16 = 18789
    let processIdentifier: pid_t
    let sandboxForwardPort: UInt16?
    private(set) var isRunning = true

    private init(processIdentifier: pid_t, sandboxForwardPort: UInt16?) {
        self.processIdentifier = processIdentifier
        self.sandboxForwardPort = sandboxForwardPort
    }

    static func configuration() throws -> Configuration {
        Configuration(remotePort: 18789)
    }

    static func create(configuration _: Configuration) async throws -> RemotePortTunnel {
        let tunnel = RemotePortTunnel(
            processIdentifier: pid_t(createdTunnels.count + 1),
            sandboxForwardPort: sandboxPortAvailable ? 18790 : nil)
        createdTunnels.append(tunnel)
        return tunnel
    }

    func canAddSandboxForward(configuration _: Configuration) -> Bool {
        self.sandboxForwardPort == nil && sandboxPortAvailable
    }

    func terminate() async {
        self.isRunning = false
    }
}

actor PortGuardian {
    static let shared = PortGuardian()
    func isListening(port _: Int, pid: Int32? = nil) -> Bool {
        createdTunnels.first { $0.processIdentifier == pid }?.isRunning == true
    }
}

@main
enum RemoteTunnelManagerFixture {
    private nonisolated(unsafe) static var failures = 0

    static func main() async {
        await self.tunnelWithoutSandboxForwardIsReplacedOnceThePortIsFree()
        if self.failures > 0 { exit(1) }
        print("PASS: RemoteTunnelManager headless reuse regressions")
    }

    private static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            self.failures += 1
            print("FAIL: \(message)")
        }
    }

    private static func tunnelWithoutSandboxForwardIsReplacedOnceThePortIsFree() async {
        let manager = RemoteTunnelManager()
        // A hosted Gateway turning off still holds the sandbox port while the reconnect opens a tunnel.
        sandboxPortAvailable = false
        let first = try? await manager.ensureControlTunnelRoute()
        let busyReuse = try? await manager.ensureControlTunnelRoute()
        self.expect(createdTunnels.count == 1, "tunnel replaced while the sandbox port was still busy")
        self.expect(first != nil && busyReuse == first, "busy sandbox port changed the control route")

        // Gateway shutdown finishes; the next ensure must not reuse the tunnel without the forward.
        sandboxPortAvailable = true
        let replaced = try? await manager.ensureControlTunnelRoute()
        self.expect(createdTunnels.count == 2, "tunnel without the sandbox forward was reused after the port freed")
        self.expect(createdTunnels.first?.isRunning == false, "replaced SSH tunnel was not terminated")
        self.expect(createdTunnels.last?.sandboxForwardPort == 18790, "replacement tunnel lacks the sandbox forward")
        self.expect(replaced != nil && replaced != first, "replacement did not publish a new route")

        let settled = try? await manager.ensureControlTunnelRoute()
        self.expect(createdTunnels.count == 2 && settled == replaced, "tunnel with the forward was not reused")
        await manager.stopAll()
    }
}
