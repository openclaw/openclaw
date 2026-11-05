import Testing
@testable import OpenClaw

#if canImport(Darwin)
import Darwin
import Foundation

struct RemotePortTunnelTests {
    @Test func `tunnel owns its SSH process instead of multiplexing`() {
        let options = RemotePortTunnel.sshOptions(localPort: 28789, remotePort: 18789, hostKeyPolicy: .strict)

        #expect(options.contains("ControlMaster=no"))
        #expect(options.contains("ControlPath=none"))
        #expect(options.contains("ControlPersist=no"))
        #expect(options.contains("ForkAfterAuthentication=no"))
        #expect(options.contains("28789:127.0.0.1:18789"))
        #expect(options.contains("StrictHostKeyChecking=yes"))
        #expect(options.contains("UpdateHostKeys=yes"))
    }

    @Test func `tunnel forwards the remote widget sandbox port to the same local port`() throws {
        let sandbox = try Self.bindLoopbackPort()
        Darwin.close(sandbox.fd)
        let remotePort = Int(sandbox.port) - 1

        let options = RemotePortTunnel.sshOptions(localPort: 28789, remotePort: remotePort, hostKeyPolicy: .strict)

        #expect(options.contains("28789:127.0.0.1:\(remotePort)"))
        #expect(options.contains("\(sandbox.port):127.0.0.1:\(sandbox.port)"))
    }

    @Test func `occupied local sandbox port keeps only the control forward`() throws {
        let sandbox = try Self.bindLoopbackPort()
        defer { Darwin.close(sandbox.fd) }
        let remotePort = Int(sandbox.port) - 1

        let options = RemotePortTunnel.sshOptions(localPort: 28789, remotePort: remotePort, hostKeyPolicy: .strict)

        #expect(options.contains("28789:127.0.0.1:\(remotePort)"))
        #expect(options.count(where: { $0 == "-L" }) == 1)
    }

    @Test func `hosted local Gateway keeps its ports from the sandbox forward`() throws {
        let sandbox = try Self.bindLoopbackPort()
        Darwin.close(sandbox.fd)
        let remotePort = Int(sandbox.port) - 1
        // Hosting repair moves this Mac's Gateway next to the tunnel port; its listener may not be bound yet.
        let reserved = RemotePortTunnel.reservedLocalPorts(
            root: [:], hostsLocalGateway: true, localGatewayPort: Int(sandbox.port))

        let options = RemotePortTunnel.sshOptions(
            localPort: UInt16(remotePort), remotePort: remotePort, hostKeyPolicy: .strict,
            reservedLocalPorts: reserved)

        #expect(reserved == [Int(sandbox.port), Int(sandbox.port) + 1])
        #expect(options.count(where: { $0 == "-L" }) == 1)
    }

    @MainActor
    @Test(arguments: [(18790, 18789), (18789, 28789)])
    func `hosting preference rather than a split port decides the reserved ports`(
        ports: (gateway: Int, tunnel: Int)) async throws
    {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager().removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: ["gatewayPort": nil, hostsLocalGatewayWithRemotePrimaryKey: nil])
        {
            // Hosting repair separates gateway.port from the tunnel port; turning hosting off keeps it.
            try #require(OpenClawConfigFile.saveDict(["gateway": [
                "mode": "remote", "port": ports.gateway,
                "remote": [
                    "transport": "ssh", "sshTarget": "operator@gateway.example",
                    "url": "ws://127.0.0.1:\(ports.tunnel)", "remotePort": 18789,
                ],
            ]]))
            AppDefaults.standard.set(true, forKey: hostsLocalGatewayWithRemotePrimaryKey)
            let hosting = try RemotePortTunnel.configuration()
            #expect(hosting.reservedLocalPorts == [ports.gateway, ports.gateway + 1])

            AppDefaults.standard.set(false, forKey: hostsLocalGatewayWithRemotePrimaryKey)
            let notHosting = try RemotePortTunnel.configuration()
            #expect(notHosting.reservedLocalPorts.isEmpty)
            // The tunnel manager replaces a running tunnel whose configuration differs.
            #expect(notHosting != hosting)
        }
    }

    private static func bindLoopbackPort() throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, length) == 0 && getsockname(fd, sa, &length) == 0
            }
        }
        guard fd >= 0, bound, UInt16(bigEndian: addr.sin_port) > 1 else {
            if fd >= 0 { Darwin.close(fd) }
            throw POSIXError(.EADDRNOTAVAIL)
        }
        return (fd, UInt16(bigEndian: addr.sin_port))
    }

    @Test func `tunnel requires explicit opt in to use SSH config host key policy`() {
        let options = RemotePortTunnel.sshOptions(
            localPort: 28789,
            remotePort: 18789,
            hostKeyPolicy: .openssh)

        #expect(!options.contains { $0.hasPrefix("StrictHostKeyChecking=") })
        #expect(!options.contains { $0.hasPrefix("UpdateHostKeys=") })
    }

    @Test(arguments: ["ws://127.0.0.1:19089", "ws://localhost:19089", "ws://[::1]:19089"])
    func `tunnel local port comes from the remote URL independently of the local gateway`(url: String) {
        let root: [String: Any] = ["gateway": ["port": 18789, "remote": ["url": url]]]
        #expect(RemotePortTunnel.localPort(root: root) == 19089)
    }

    @Test(arguments: [("", 19789), ("ws://localhost", 18789), ("wss://gateway.example:19089", 19789)])
    func `legacy fallback preserves explicit loopback URL defaults`(scenario: (String, Int)) {
        let (url, expectedPort) = scenario
        let root: [String: Any] = ["gateway": ["port": 19789, "remote": ["url": url]]]
        #expect(RemotePortTunnel.localPort(root: root, legacyPort: 19789, environment: [:]) == expectedPort)
    }

    @Test(arguments: [18789, 19789])
    func `legacy SSH primary keeps both ports before hosting is enabled`(legacyPort: Int) {
        var remote: [String: Any] = ["transport": "ssh", "sshTarget": "operator@gateway.example"]
        let root: [String: Any] = ["gateway": ["mode": "remote", "port": legacyPort, "remote": remote]]
        let ports = RemotePortTunnel.ports(
            root: root, sshHost: "gateway.example", legacyPort: legacyPort, environment: [:])
        #expect(ports.local == legacyPort)
        #expect(ports.remote == legacyPort)
        remote["remotePort"] = 18800
        let explicit = RemotePortTunnel.ports(
            root: ["gateway": ["remote": remote]], sshHost: "gateway.example", legacyPort: legacyPort, environment: [:])
        #expect(explicit.local == legacyPort)
        #expect(explicit.remote == 18800)
    }

    @Test(arguments: [(nil as String?, 19889), ("19989", 19989)])
    func `legacy SSH keeps a live configured listener separate from the reserved default`(scenario: (String?, Int)) {
        let (override, expectedLocalPort) = scenario
        let root: [String: Any] = ["gateway": [
            "mode": "remote", "port": 19889,
            "remote": ["transport": "ssh", "sshTarget": "operator@gateway.example"],
        ]]
        let ports = RemotePortTunnel.ports(
            root: root, sshHost: "gateway.example", legacyPort: 19789,
            environment: override.map { ["OPENCLAW_GATEWAY_PORT": $0] } ?? [:])
        #expect(ports.local == expectedLocalPort)
        #expect(ports.remote == 19789)
    }

    @Test(arguments: [false, true])
    func `remote port survives removal of the local bind port`(explicitRemotePort: Bool) {
        var remote: [String: Any] = ["url": "ws://127.0.0.1:19089"]
        if explicitRemotePort { remote["remotePort"] = 18789 }
        var gateway: [String: Any] = ["port": 19089, "remote": remote]
        for hasLocalPort in [true, false] {
            if !hasLocalPort { gateway.removeValue(forKey: "port") }
            let root: [String: Any] = ["gateway": gateway]
            let resolved = RemotePortTunnel.resolveRemotePortOverride(
                defaultRemotePort: 18789, for: "gateway.example", root: root) ?? 18789
            #expect(resolved == (explicitRemotePort ? 18789 : 19089))
            #expect(RemotePortTunnel.localPort(root: root) == 19089)
        }
    }
}

struct RemotePortTunnelSocketTests {
    @Test func `port is free detects I pv4 listener`() {
        var fd = socket(AF_INET, SOCK_STREAM, 0)
        #expect(fd >= 0)
        guard fd >= 0 else { return }
        defer {
            if fd >= 0 { _ = Darwin.close(fd) }
        }

        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout.size(ofValue: one)))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bound = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        #expect(bound == 0)
        guard bound == 0 else { return }
        #expect(Darwin.listen(fd, 1) == 0)

        var name = sockaddr_in()
        var nameLen = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &name) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                getsockname(fd, sa, &nameLen)
            }
        }
        #expect(got == 0)
        guard got == 0 else { return }

        let port = UInt16(bigEndian: name.sin_port)
        #expect(RemotePortTunnel.portIsFree(port) == false)

        _ = Darwin.close(fd)
        fd = -1

        // In parallel test runs, another test may briefly grab the same ephemeral port.
        // Poll for a short window to avoid flakiness.
        let deadline = Date().addingTimeInterval(0.5)
        var free = false
        while Date() < deadline {
            if RemotePortTunnel.portIsFree(port) {
                free = true
                break
            }
            usleep(10000) // 10ms
        }
        #expect(free == true)
    }
}

#endif
