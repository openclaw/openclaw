import Testing
@testable import OpenClaw

#if canImport(Darwin)
import Darwin
import Foundation

struct RemotePortTunnelTests {
    @Test func `tunnel owns its SSH process instead of multiplexing`() {
        let options = RemotePortTunnel._testSSHOptions(localPort: 28789, remotePort: 18789)

        #expect(options.contains("ControlMaster=no"))
        #expect(options.contains("ControlPath=none"))
        #expect(options.contains("ControlPersist=no"))
        #expect(options.contains("ForkAfterAuthentication=no"))
        #expect(options.contains("28789:127.0.0.1:18789"))
        #expect(options.contains("StrictHostKeyChecking=yes"))
        #expect(options.contains("UpdateHostKeys=yes"))
    }

    @Test func `tunnel requires explicit opt in to use SSH config host key policy`() {
        let options = RemotePortTunnel._testSSHOptions(
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

    @Test(arguments: ["", "ws://localhost", "wss://gateway.example:19089"])
    func `tunnel local port defaults without borrowing the local gateway port`(url: String) {
        let root: [String: Any] = ["gateway": ["port": 19789, "remote": ["url": url]]]
        #expect(RemotePortTunnel.localPort(root: root) == 18789)
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
        #expect(RemotePortTunnel._testPortIsFree(port) == false)

        _ = Darwin.close(fd)
        fd = -1

        // In parallel test runs, another test may briefly grab the same ephemeral port.
        // Poll for a short window to avoid flakiness.
        let deadline = Date().addingTimeInterval(0.5)
        var free = false
        while Date() < deadline {
            if RemotePortTunnel._testPortIsFree(port) {
                free = true
                break
            }
            usleep(10000) // 10ms
        }
        #expect(free == true)
    }
}

#endif
