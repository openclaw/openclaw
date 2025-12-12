import Foundation
import Network
import OSLog

private let webChatServerLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChatServer")

/// Very small loopback-only HTTP server that serves the bundled WebChat assets.
/// Not Sendable-safe; all state lives on the private serial queue.
final class WebChatServer: @unchecked Sendable {
    static let shared = WebChatServer()

    private let queue = DispatchQueue(label: "com.steipete.clawdis.webchatserver")
    private var listener: NWListener?
    private var root: URL?
    private var port: NWEndpoint.Port?

    /// Start the local HTTP server if it isn't already running. Safe to call multiple times.
    func start(root: URL, preferredPort: UInt16? = nil) {
        self.queue.async {
            webChatServerLogger.debug("WebChatServer start requested root=\(root.path, privacy: .public)")
            if self.listener != nil { return }
            self.root = root
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            params.requiredInterfaceType = .loopback
            let prefer = preferredPort.flatMap { NWEndpoint.Port(rawValue: $0) }
            do {
                let listener = try NWListener(using: params, on: prefer ?? .any)
                listener.stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .ready:
                        self?.port = listener.port
                        webChatServerLogger.debug("WebChatServer ready on 127.0.0.1:\(listener.port?.rawValue ?? 0)")
                    case let .failed(error):
                        webChatServerLogger
                            .error("WebChatServer failed: \(error.localizedDescription, privacy: .public)")
                        self?.listener = nil
                    default:
                        break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    self?.handle(connection: connection)
                }
                listener.start(queue: self.queue)
                self.listener = listener
            } catch {
                if let prefer {
                    do {
                        let listener = try NWListener(using: params, on: .any)
                        listener.stateUpdateHandler = { [weak self] state in
                            switch state {
                            case .ready:
                                self?.port = listener.port
                                webChatServerLogger.debug(
                                    "WebChatServer ready on 127.0.0.1:\(listener.port?.rawValue ?? 0)")
                            case let .failed(error):
                                webChatServerLogger
                                    .error("WebChatServer failed: \(error.localizedDescription, privacy: .public)")
                                self?.listener = nil
                            default:
                                break
                            }
                        }
                        listener.newConnectionHandler = { [weak self] connection in
                            self?.handle(connection: connection)
                        }
                        listener.start(queue: self.queue)
                        self.listener = listener
                        webChatServerLogger.debug(
                            "WebChatServer fell back to ephemeral port (preferred \(prefer.rawValue))")
                    } catch {
                        webChatServerLogger
                            .error("WebChatServer could not start: \(error.localizedDescription, privacy: .public)")
                    }
                } else {
                    webChatServerLogger
                        .error("WebChatServer could not start: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }

    /// Returns the base URL once the server is ready, otherwise nil.
    func baseURL() -> URL? {
        var url: URL?
        self.queue.sync {
            if let port {
                url = URL(string: "http://127.0.0.1:\(port.rawValue)/webchat/")
            }
        }
        return url
    }

    private func handle(connection: NWConnection) {
        webChatServerLogger.debug("WebChatServer new connection")
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                webChatServerLogger.debug("WebChatServer connection ready")
                self.receive(on: connection)
            case let .failed(error):
                webChatServerLogger
                    .error("WebChatServer connection failed: \(error.localizedDescription, privacy: .public)")
                connection.cancel()
            default:
                break
            }
        }
        connection.start(queue: self.queue)
    }

    private func receive(on connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            if let data, !data.isEmpty {
                self.respond(to: connection, requestData: data)
            } else if isComplete {
                connection.cancel()
                return
            }
            if isComplete || error != nil {
                if let error {
                    webChatServerLogger
                        .error("WebChatServer receive error: \(error.localizedDescription, privacy: .public)")
                }
                connection.cancel()
            } else {
                self.receive(on: connection)
            }
        }
    }

    private func respond(to connection: NWConnection, requestData: Data) {
        guard let requestText = String(data: requestData, encoding: .utf8) else {
            webChatServerLogger.error("WebChatServer could not decode request (\(requestData.count) bytes)")
            connection.cancel()
            return
        }
        guard let requestLine = requestText.components(separatedBy: "\r\n").first else {
            webChatServerLogger.error("WebChatServer missing request line")
            connection.cancel()
            return
        }
        webChatServerLogger.debug("WebChatServer request line=\(requestLine, privacy: .public)")
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            webChatServerLogger.error("WebChatServer invalid request: \(requestLine, privacy: .public)")
            connection.cancel()
            return
        }
        let method = parts[0]
        let includeBody = method == "GET"
        guard includeBody || method == "HEAD" else {
            webChatServerLogger.error(
                "WebChatServer unsupported request method: \(requestLine, privacy: .public)")
            connection.cancel()
            return
        }
        var path = String(parts[1])
        if let qIdx = path.firstIndex(of: "?") {
            path = String(path[..<qIdx])
        }
        if path.hasPrefix("/") { path.removeFirst() }
        if path.hasPrefix("webchat/") {
            webChatServerLogger.debug("WebChatServer request raw path=\(parts[1], privacy: .public)")
            path = String(path.dropFirst("webchat/".count))
        }
        webChatServerLogger.debug("WebChatServer request path=\(path, privacy: .public)")
        if path.isEmpty { path = "index.html" }

        guard let root else {
            connection.cancel()
            return
        }
        let fileURL = root.appendingPathComponent(path)
        webChatServerLogger.debug("WebChatServer resolved file=\(fileURL.path, privacy: .public)")
        // Simple directory traversal guard: served files must live under the bundled web root.
        guard fileURL.path.hasPrefix(root.path) else {
            let forbidden = Data("Forbidden".utf8)
            self.send(
                status: 403,
                mime: "text/plain",
                body: forbidden,
                contentLength: forbidden.count,
                includeBody: includeBody,
                over: connection)
            return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            webChatServerLogger.error("WebChatServer 404 missing \(fileURL.lastPathComponent, privacy: .public)")
            self.send(
                status: 404,
                mime: "text/plain",
                body: Data("Not Found".utf8),
                contentLength: "Not Found".utf8.count,
                includeBody: includeBody,
                over: connection)
            return
        }
        let mime = self.mimeType(forExtension: fileURL.pathExtension)
        self.send(
            status: 200,
            mime: mime,
            body: data,
            contentLength: data.count,
            includeBody: includeBody,
            over: connection)
    }

    private func send(
        status: Int,
        mime: String,
        body: Data,
        contentLength: Int,
        includeBody: Bool,
        over connection: NWConnection)
    {
        let headers = "HTTP/1.1 \(status) \(statusText(status))\r\n" +
            "Content-Length: \(contentLength)\r\n" +
            "Content-Type: \(mime)\r\n" +
            "Connection: close\r\n\r\n"
        var response = Data(headers.utf8)
        if includeBody {
            response.append(body)
        }
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func statusText(_ code: Int) -> String {
        switch code {
        case 200: "OK"
        case 403: "Forbidden"
        case 404: "Not Found"
        default: "Error"
        }
    }

    private func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": "text/html; charset=utf-8"
        case "js", "mjs": "application/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json", "map": "application/json; charset=utf-8"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "ttf": "font/ttf"
        default: "application/octet-stream"
        }
    }
}
