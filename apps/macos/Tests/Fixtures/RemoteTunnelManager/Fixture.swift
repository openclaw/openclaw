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
nonisolated(unsafe) var sandboxForwardSucceeds = false
nonisolated(unsafe) var controlTunnels: [RemotePortTunnel] = []
nonisolated(unsafe) var sandboxForwards: [RemotePortTunnel] = []
nonisolated(unsafe) var sandboxForwardAttempts = 0
nonisolated(unsafe) var nextPID: pid_t = 100

/// Stands in for the SSH process. Gateway tunnels and sandbox forwards are separate processes;
/// `sandboxForwardPort`/`canAddSandboxForward` keep the fixture compiling against the earlier
/// single-process manager so it can show that manager's failure.
final class RemotePortTunnel: @unchecked Sendable {
    struct Configuration: Equatable, Sendable {
        let remotePort: Int
        let reservedLocalPorts: Set<Int>
    }

    let localPort: UInt16
    let processIdentifier: pid_t
    let sandboxForwardPort: UInt16? = nil
    private(set) var isRunning = true

    private init(localPort: UInt16) {
        nextPID += 1
        self.processIdentifier = nextPID
        self.localPort = localPort
    }

    static func configuration() throws -> Configuration {
        Configuration(remotePort: 18789, reservedLocalPorts: [])
    }

    static func create(configuration _: Configuration) async throws -> RemotePortTunnel {
        let tunnel = RemotePortTunnel(localPort: 18789)
        controlTunnels.append(tunnel)
        return tunnel
    }

    static func createSandboxForward(configuration _: Configuration, port: UInt16) async throws -> RemotePortTunnel {
        sandboxForwardAttempts += 1
        // ssh exits 255 when its bind fails ("Address already in use").
        guard sandboxForwardSucceeds else { throw POSIXError(.EADDRINUSE) }
        let forward = RemotePortTunnel(localPort: port)
        sandboxForwards.append(forward)
        return forward
    }

    static func availableSandboxForwardPort(
        localPort _: UInt16, remotePort _: Int, reservedLocalPorts _: Set<Int>) -> UInt16?
    {
        sandboxPortAvailable ? 18790 : nil
    }

    func canAddSandboxForward(configuration _: Configuration) -> Bool {
        sandboxPortAvailable
    }

    func terminate() async {
        self.isRunning = false
    }
}

actor PortGuardian {
    static let shared = PortGuardian()
    func isListening(port _: Int, pid: Int32? = nil) -> Bool {
        (controlTunnels + sandboxForwards).first { $0.processIdentifier == pid }?.isRunning == true
    }
}

@main
enum RemoteTunnelManagerFixture {
    private nonisolated(unsafe) static var failures = 0

    static func main() async {
        await self.failedSandboxForwardNeverTouchesTheGatewayTunnel()
        await self.sandboxForwardRunsBesideTheGatewayTunnel()
        if self.failures > 0 { exit(1) }
        print("PASS: RemoteTunnelManager headless reuse regressions")
    }

    private static func expect(_ condition: Bool, _ message: String) {
        if !condition {
            self.failures += 1
            print("FAIL: \(message)")
        }
    }

    private static func settle() async {
        for _ in 0..<50 {
            await Task.yield()
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
    }

    private static func reset() {
        sandboxPortAvailable = false
        sandboxForwardSucceeds = false
        controlTunnels = []
        sandboxForwards = []
        sandboxForwardAttempts = 0
    }

    private static func failedSandboxForwardNeverTouchesTheGatewayTunnel() async {
        self.reset()
        let manager = RemoteTunnelManager()
        let first = try? await manager.ensureControlTunnelRoute()

        // The probe passes but ssh cannot bind (a wildcard GatewayPorts listener, a lost race).
        sandboxPortAvailable = true
        let afterFailure = try? await manager.ensureControlTunnelRoute()
        await self.settle()
        let retried = try? await manager.ensureControlTunnelRoute()
        await self.settle()

        self.expect(controlTunnels.count == 1, "Gateway tunnel was replaced for the widget forward")
        self.expect(controlTunnels.first?.isRunning == true, "Gateway tunnel was terminated for the widget forward")
        self.expect(first != nil && afterFailure == first && retried == first, "Gateway route changed")
        self.expect(sandboxForwardAttempts == 1, "failed widget forward retried without backoff")
        await manager.stopAll()
    }

    private static func sandboxForwardRunsBesideTheGatewayTunnel() async {
        self.reset()
        sandboxPortAvailable = true
        sandboxForwardSucceeds = true
        let manager = RemoteTunnelManager()
        let route = try? await manager.ensureControlTunnelRoute()
        await self.settle()
        let reused = try? await manager.ensureControlTunnelRoute()
        await self.settle()

        self.expect(
            sandboxForwards.count == 1 && sandboxForwards.first?.isRunning == true,
            "widget forward did not open beside the Gateway tunnel")
        self.expect(controlTunnels.count == 1 && route != nil && reused == route, "Gateway route changed")

        await manager.stopAll()
        self.expect(sandboxForwards.first?.isRunning == false, "retirement left the widget forward running")
        self.expect(controlTunnels.first?.isRunning == false, "retirement left the Gateway tunnel running")
    }
}
