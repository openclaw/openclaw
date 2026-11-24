import Darwin
import Foundation
import OpenClawKit
import Synchronization

/// Loopback HTTP/WebSocket proxy that lets the dashboard WebView reach the claw over the Mac's
/// operator tunnel. The tunnel key is the authority, so the proxy admits only requests carrying
/// its per-launch secret cookie (set in the dashboard's cookie store) and its exact Host. Other
/// local processes, including commands the node runs, cannot borrow the operator grant.
final class MacOpenClawIDDashboardProxy: Sendable {
    static let cookieName = "openclaw_ocid_dashboard"

    let baseURL: URL
    let cookie: HTTPCookie
    private let listener: Int32
    private let secret: String
    private let host: String
    private let logicalOrigin: URL
    private let session: OpenClawIDNodeWebSocketSession
    private let tunnel: OpenClawIDNodeTunnel
    private let state = Mutex<(stopping: Bool, clients: [UUID: Task<Void, Never>], accept: Task<Void, Never>?)>(
        (false, [:], nil))

    private init(listener: Int32, port: UInt16, tunnel: OpenClawIDNodeTunnel, logicalOrigin: URL) throws {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw MacNodeOpenClawIDBridgeError.unavailable
        }
        self.secret = bytes.map { String(format: "%02x", $0) }.joined()
        self.listener = listener
        self.host = "127.0.0.1:\(port)"
        self.baseURL = URL(string: "http://127.0.0.1:\(port)/")!
        self.logicalOrigin = logicalOrigin
        self.tunnel = tunnel
        self.session = OpenClawIDNodeWebSocketSession(tunnel: tunnel, logicalOrigin: logicalOrigin, role: .operator)
        guard let cookie = HTTPCookie(properties: [
            .name: Self.cookieName,
            .value: self.secret,
            .domain: "127.0.0.1",
            .path: "/",
            .init("HttpOnly"): "TRUE",
            .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict,
        ]) else { throw MacNodeOpenClawIDBridgeError.unavailable }
        self.cookie = cookie
    }

    /// Binds an ephemeral 127.0.0.1 port and starts accepting.
    static func start(
        tunnel: OpenClawIDNodeTunnel,
        logicalOrigin: URL,
        onUnexpectedStop: @escaping @Sendable () -> Void) async throws -> MacOpenClawIDDashboardProxy
    {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw MacNodeOpenClawIDBridgeError.unavailable }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { address in
                bind(fd, address, length) == 0 && listen(fd, 64) == 0 &&
                    getsockname(fd, address, &length) == 0
            }
        }
        guard bound, fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else {
            close(fd)
            throw MacNodeOpenClawIDBridgeError.unavailable
        }
        let proxy: MacOpenClawIDDashboardProxy
        do {
            proxy = try MacOpenClawIDDashboardProxy(
                listener: fd, port: UInt16(bigEndian: address.sin_port), tunnel: tunnel, logicalOrigin: logicalOrigin)
        } catch {
            close(fd)
            throw error
        }
        let accept = Task.detached { [proxy] in
            await proxy.acceptLoop()
            if !proxy.state.withLock({ $0.stopping }) { onUnexpectedStop() }
        }
        proxy.state.withLock { $0.accept = accept }
        return proxy
    }

    /// Stops accepting, cancels every client and waits for them before closing the listener.
    func shutdown() async {
        let (accept, clients) = self.state.withLock { state -> (Task<Void, Never>?, [Task<Void, Never>]) in
            guard !state.stopping else { return (nil, []) }
            state.stopping = true
            return (state.accept, Array(state.clients.values))
        }
        Darwin.shutdown(self.listener, SHUT_RDWR)
        for client in clients {
            client.cancel()
        }
        for client in clients {
            await client.value
        }
        await accept?.value
        close(self.listener)
    }

    private func acceptLoop() async {
        while !Task.isCancelled {
            let client = await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async {
                    var fd: Int32
                    repeat {
                        fd = Darwin.accept(self.listener, nil, nil)
                    } while fd < 0 && errno == EINTR
                    continuation.resume(returning: fd)
                }
            }
            guard client >= 0 else { return }
            _ = fcntl(client, F_SETFD, FD_CLOEXEC)
            var noSigPipe: Int32 = 1
            setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            let id = UUID()
            let admitted = self.state.withLock { state -> Bool in
                guard !state.stopping else { return false }
                state.clients[id] = Task.detached { [self] in
                    await self.serve(client)
                    close(client)
                    _ = self.state.withLock { $0.clients.removeValue(forKey: id) }
                }
                return true
            }
            if !admitted { close(client) }
        }
    }

    private func serve(_ fd: Int32) async {
        guard let io = try? MacNodeOpenClawIDBridgeIO(handle: FileHandle(fileDescriptor: fd, closeOnDealloc: false))
        else { return }
        let reader = MacNodeOpenClawIDBridgeReader(io: io)
        do {
            try await withTaskCancellationHandler {
                let bytes = try await reader.through(
                    Data([13, 10, 13, 10]), limit: MacNodeOpenClawIDBridgeRequest.maximumHeadBytes)
                let parsed = try MacNodeOpenClawIDBridgeRequest.parse(bytes)
                guard let request = self.admit(parsed) else {
                    try await io.write(Data(
                        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8))
                    return
                }
                if request.isWebSocket {
                    // The Control UI's Gateway socket is the root path, never the worker route.
                    try await MacNodeOpenClawIDBridgeWebSocket.serve(
                        request: request, reader: reader, io: io, path: "/")
                    {
                        try await self.session.prepareWebSocket(request: self.upstreamRequest(request))
                    }
                } else {
                    try await MacNodeOpenClawIDBridgeHTTP.serve(
                        request: request, reader: reader, io: io, tunnel: self.tunnel, dashboard: true)
                }
            } onCancel: { io.interrupt() }
        } catch {
            io.interrupt()
        }
    }

    /// Admits only the exact loopback Host with this launch's cookie, then presents the request
    /// to the Gateway as coming from the claw's own origin, without the proxy cookie.
    private func admit(_ request: MacNodeOpenClawIDBridgeRequest) -> MacNodeOpenClawIDBridgeRequest? {
        guard request.values("host") == [self.host] else { return nil }
        // Only the dashboard's own documents may drive the proxy: refuse cross-origin requests
        // and WebSocket upgrades from any other page, even one that is same-site on loopback.
        let ownOrigin = "http://\(self.host)"
        guard request.values("origin").allSatisfy({ $0 == ownOrigin }),
              request.values("sec-fetch-site").allSatisfy({ $0 == "same-origin" || $0 == "none" })
        else { return nil }
        let pairs = request.values("cookie").flatMap { $0.split(separator: ";") }
            .map { $0.trimmingCharacters(in: .whitespaces) }
        let presented = pairs.filter { $0.hasPrefix(Self.cookieName + "=") }
            .map { String($0.dropFirst(Self.cookieName.count + 1)) }
        guard presented.count == 1, Self.constantTimeEqual(presented[0], self.secret) else { return nil }
        let others = pairs.filter { !$0.hasPrefix(Self.cookieName + "=") }
        let logicalHost = self.logicalOrigin.host ?? ""
        let logicalOriginText = "https://\(logicalHost)"
        var headers = request.headers.filter { !["cookie", "host", "origin", "referer"].contains($0[0]) }
        headers.append(["host", logicalHost])
        if !others.isEmpty { headers.append(["cookie", others.joined(separator: "; ")]) }
        for origin in request.values("origin") {
            headers.append(["origin", origin == "http://\(self.host)" ? logicalOriginText : origin])
        }
        return MacNodeOpenClawIDBridgeRequest(
            method: request.method, path: request.path, headers: headers, body: request.body)
    }

    private func upstreamRequest(_ request: MacNodeOpenClawIDBridgeRequest) throws -> URLRequest {
        guard var components = URLComponents(url: self.logicalOrigin, resolvingAgainstBaseURL: false) else {
            throw MacNodeOpenClawIDBridgeError.malformedRequest
        }
        let parts = request.path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        components.percentEncodedPath = String(parts[0])
        components.percentEncodedQuery = parts.count > 1 ? String(parts[1]) : nil
        guard let url = components.url else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
        var upstream = URLRequest(url: url)
        for pair in MacNodeOpenClawIDBridgeRequest.endToEndHeaders(request.headers)
            where !pair[0].hasPrefix("sec-websocket-") && pair[0] != "host"
        {
            upstream.addValue(pair[1], forHTTPHeaderField: pair[0])
        }
        return upstream
    }

    /// WebKit content rules that strip cookies from every request except this proxy's origin.
    static func cookieRules(for baseURL: URL) throws -> String {
        guard let port = baseURL.port else { throw MacNodeOpenClawIDBridgeError.unavailable }
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block-cookies"]],
        ] + ["http", "ws"].map { scheme in
            [
                "trigger": ["url-filter": "^\(scheme)://127\\.0\\.0\\.1:\(port)/"],
                "action": ["type": "ignore-previous-rules"],
            ]
        }
        return try String(bytes: JSONSerialization.data(withJSONObject: rules), encoding: .utf8)!
    }

    private static func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8)
        let b = Array(right.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
