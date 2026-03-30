import Dispatch
import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

struct ControlSocketRequest: Sendable {
    let method: String
    let path: String
    let body: String

    var routePath: String {
        path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map(String.init) ?? path
    }

    var query: [String: String] {
        guard let components = URLComponents(string: "http://localhost\(path)") else { return [:] }
        return (components.queryItems ?? []).reduce(into: [String: String]()) { partial, item in
            partial[item.name] = item.value ?? ""
        }
    }
}

struct ControlSocketResponse: Sendable {
    let statusCode: Int
    let body: String
    let contentType: String

    init(statusCode: Int, body: String, contentType: String = "application/json") {
        self.statusCode = statusCode
        self.body = body
        self.contentType = contentType
    }

    static func ok(body: String, contentType: String = "application/json") -> ControlSocketResponse {
        ControlSocketResponse(statusCode: 200, body: body, contentType: contentType)
    }

    static func notFound() -> ControlSocketResponse {
        ControlSocketResponse(
            statusCode: 404,
            body: "{\"ok\":false,\"error\":\"not_found\"}")
    }

    static func badRequest() -> ControlSocketResponse {
        ControlSocketResponse(
            statusCode: 400,
            body: "{\"ok\":false,\"error\":\"bad_request\"}")
    }

    static func serverError(_ message: String) -> ControlSocketResponse {
        ControlSocketResponse(
            statusCode: 500,
            body: "{\"ok\":false,\"error\":\"\(message)\"}")
    }
}

enum ControlSocketError: Error {
    case pathTooLong
    case createSocketFailed(Int32)
    case bindFailed(Int32)
    case listenFailed(Int32)
    case connectFailed(Int32)
}

final class ControlSocketServer: @unchecked Sendable {
    typealias RequestHandler = @Sendable (ControlSocketRequest) async -> ControlSocketResponse

    private let socketURL: URL
    private let handler: RequestHandler
    private let queue = DispatchQueue(label: "swabble.control.socket", qos: .utility)

    private var listenFD: Int32 = -1
    private var acceptSource: DispatchSourceRead?

    init(socketURL: URL = SwabbleRuntimePaths.controlSocketURL, handler: @escaping RequestHandler) {
        self.socketURL = socketURL
        self.handler = handler
    }

    deinit {
        stop()
    }

    func start() throws {
        stop()

        try FileManager.default.createDirectory(
            at: socketURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)

        _ = unlink(socketURL.path)

        let fd = socket(AF_UNIX, Int32(SOCK_STREAM), 0)
        guard fd >= 0 else { throw ControlSocketError.createSocketFailed(errno) }

        if fcntl(fd, F_SETFL, O_NONBLOCK) == -1 {
            let code = errno
            close(fd)
            throw ControlSocketError.createSocketFailed(code)
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let copied = socketURL.path.withCString { cPath in
            withUnsafeMutableBytes(of: &addr.sun_path) { rawBytes -> Bool in
                guard rawBytes.count > 1 else { return false }
                rawBytes.initializeMemory(as: UInt8.self, repeating: 0)
                let maxLength = rawBytes.count - 1
                let pathLength = strnlen(cPath, maxLength + 1)
                guard pathLength <= maxLength else { return false }
                strncpy(rawBytes.baseAddress?.assumingMemoryBound(to: CChar.self), cPath, maxLength)
                return true
            }
        }

        guard copied else {
            close(fd)
            throw ControlSocketError.pathTooLong
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard bindResult == 0 else {
            let code = errno
            close(fd)
            throw ControlSocketError.bindFailed(code)
        }

        guard listen(fd, 16) == 0 else {
            let code = errno
            close(fd)
            throw ControlSocketError.listenFailed(code)
        }

        listenFD = fd

        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            self?.acceptReadyConnections()
        }
        source.setCancelHandler { [weak self] in
            guard let self else { return }
            if self.listenFD >= 0 {
                close(self.listenFD)
                self.listenFD = -1
            }
            _ = unlink(self.socketURL.path)
        }
        source.resume()
        acceptSource = source
    }

    func stop() {
        acceptSource?.cancel()
        acceptSource = nil
    }

    private func acceptReadyConnections() {
        guard listenFD >= 0 else { return }

        while true {
            var storage = sockaddr_storage()
            var len = socklen_t(MemoryLayout<sockaddr_storage>.size)
            let clientFD = withUnsafeMutablePointer(to: &storage) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    accept(listenFD, $0, &len)
                }
            }

            if clientFD < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK {
                    break
                }
                break
            }

            let handler = self.handler
            Task.detached(priority: .utility) {
                defer { close(clientFD) }
                guard let request = readControlSocketRequest(from: clientFD) else {
                    writeControlSocketResponse(.badRequest(), to: clientFD)
                    return
                }

                let response = await handler(request)
                writeControlSocketResponse(response, to: clientFD)
            }
        }
    }
}

enum ControlSocketClient {
    static func request(
        method: String,
        path: String,
        body: String = "",
        socketURL: URL = SwabbleRuntimePaths.controlSocketURL)
    async -> ControlSocketResponse?
    {
        await Task.detached(priority: .utility) {
            requestSync(method: method, path: path, body: body, socketURL: socketURL)
        }.value
    }

    private static func requestSync(method: String, path: String, body: String, socketURL: URL) -> ControlSocketResponse? {
        let fd = socket(AF_UNIX, Int32(SOCK_STREAM), 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let copied = socketURL.path.withCString { cPath in
            withUnsafeMutableBytes(of: &addr.sun_path) { rawBytes -> Bool in
                guard rawBytes.count > 1 else { return false }
                rawBytes.initializeMemory(as: UInt8.self, repeating: 0)
                let maxLength = rawBytes.count - 1
                let pathLength = strnlen(cPath, maxLength + 1)
                guard pathLength <= maxLength else { return false }
                strncpy(rawBytes.baseAddress?.assumingMemoryBound(to: CChar.self), cPath, maxLength)
                return true
            }
        }

        guard copied else { return nil }

        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }

        guard connectResult == 0 else { return nil }

        let requestText = "\(method.uppercased()) \(path)\n\n\(body)"
        guard writeAll(Data(requestText.utf8), to: fd) else { return nil }
        _ = shutdown(fd, Int32(SHUT_WR))

        guard let responseData = readAll(from: fd) else { return nil }
        return parseControlSocketResponse(responseData)
    }
}

private func readControlSocketRequest(from fd: Int32) -> ControlSocketRequest? {
    guard let data = readAll(from: fd),
          let text = String(data: data, encoding: .utf8)
    else {
        return nil
    }

    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    let sections = normalized.components(separatedBy: "\n\n")
    guard let head = sections.first,
          let requestLine = head.split(separator: "\n", omittingEmptySubsequences: true).first
    else {
        return nil
    }

    let parts = requestLine.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
    guard parts.count == 2 else { return nil }

    let body = sections.dropFirst().joined(separator: "\n\n")
    return ControlSocketRequest(method: String(parts[0]), path: String(parts[1]), body: body)
}

private func parseControlSocketResponse(_ data: Data) -> ControlSocketResponse? {
    guard let text = String(data: data, encoding: .utf8) else { return nil }
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    let sections = normalized.components(separatedBy: "\n\n")

    guard let head = sections.first else { return nil }
    let lines = head.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    guard let statusLine = lines.first else { return nil }

    let statusParts = statusLine.split(separator: " ", omittingEmptySubsequences: true)
    guard statusParts.count == 2,
          statusParts[0] == "STATUS",
          let statusCode = Int(statusParts[1])
    else {
        return nil
    }

    var contentType = "application/json"
    if let contentTypeLine = lines.first(where: { $0.hasPrefix("CONTENT-TYPE ") }) {
        contentType = String(contentType.dropFirst("CONTENT-TYPE ".count))
    }

    let body = sections.dropFirst().joined(separator: "\n\n")
    return ControlSocketResponse(statusCode: statusCode, body: body, contentType: contentType)
}

private func writeControlSocketResponse(_ response: ControlSocketResponse, to fd: Int32) {
    let head = "STATUS \(response.statusCode)\nCONTENT-TYPE \(response.contentType)\n\n"
    let payload = Data((head + response.body).utf8)
    _ = writeAll(payload, to: fd)
}

private func readAll(from fd: Int32) -> Data? {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)

    while true {
        let count = recv(fd, &buffer, buffer.count, 0)
        if count > 0 {
            data.append(buffer, count: Int(count))
            if count < buffer.count {
                continue
            }
        } else if count == 0 {
            break
        } else {
            if errno == EINTR {
                continue
            }
            break
        }
    }

    return data.isEmpty ? nil : data
}

private func writeAll(_ data: Data, to fd: Int32) -> Bool {
    var written = 0
    return data.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return false }

        while written < data.count {
            let ptr = UnsafeRawPointer(base.advanced(by: written)).assumingMemoryBound(to: UInt8.self)
            let count = send(fd, ptr, data.count - written, 0)
            if count > 0 {
                written += count
                continue
            }
            if count < 0, errno == EINTR {
                continue
            }
            return false
        }

        return true
    }
}
