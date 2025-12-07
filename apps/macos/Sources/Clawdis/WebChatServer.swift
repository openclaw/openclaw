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
    func start(root: URL) {
        self.queue.async {
            webChatServerLogger.debug("WebChatServer start requested root=\(root.path, privacy: .public)")
            if self.listener != nil { return }
            self.root = root
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            do {
                let listener = try NWListener(using: params, on: .any)
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
                webChatServerLogger
                    .error("WebChatServer could not start: \(error.localizedDescription, privacy: .public)")
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
        guard parts.count >= 2, parts[0] == "GET" else {
            webChatServerLogger.error("WebChatServer non-GET request: \(requestLine, privacy: .public)")
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
        guard fileURL.path.hasPrefix(root.path) else {
            self.send(status: 403, mime: "text/plain", body: Data("Forbidden".utf8), over: connection)
            return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            webChatServerLogger.error("WebChatServer 404 missing \(fileURL.lastPathComponent, privacy: .public)")
            self.send(status: 404, mime: "text/plain", body: Data("Not Found".utf8), over: connection)
            return
        }
        let mime = self.mimeType(forExtension: fileURL.pathExtension)
        self.send(status: 200, mime: mime, body: data, over: connection)
    }

    private func send(status: Int, mime: String, body: Data, over connection: NWConnection) {
        let headers = "HTTP/1.1 \(status) \(statusText(status))\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Content-Type: \(mime)\r\n" +
            "Connection: close\r\n\r\n"
        var response = Data(headers.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func statusText(_ code: Int) -> String {
        switch code {
        case 200: return "OK"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        default: return "Error"
        }
    }

    private func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        default: return "application/octet-stream"
        }
    }
}
