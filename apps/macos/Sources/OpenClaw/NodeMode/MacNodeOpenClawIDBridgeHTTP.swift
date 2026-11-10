import Foundation
import OpenClawKit

/// Strict HTTP/1.1 subset used by the bundled worker. One request per connection;
/// no pipelining, proxy-form targets, ambiguous body framing or request trailers.
struct MacNodeOpenClawIDBridgeRequest: Sendable {
    enum Body: Sendable, Equatable { case length(Int), chunked }
    let method: String
    let path: String
    let headers: [[String]]
    let body: Body

    static let maximumHeadBytes = 64 * 1024
    private static let hopHeaders: Set<String> = [
        "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade",
    ]

    /// Parses before opening an authenticated stream, rejecting request smuggling shapes.
    static func parse(_ bytes: Data) throws -> Self {
        guard bytes.count <= self.maximumHeadBytes, bytes.suffix(4) == Data([13, 10, 13, 10]),
              let text = String(bytes: bytes.dropLast(4), encoding: .utf8)
        else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
        // HTTP delimiters are bytes; Swift treats each CRLF as one grapheme cluster.
        let lines = text.components(separatedBy: "\r\n")
        let start = (lines.first ?? "").components(separatedBy: " ")
        guard start.count == 3, Self.token(start[0]), start[2] == "HTTP/1.1",
              start[1].hasPrefix("/"), !start[1].hasPrefix("//"),
              start[1].utf8.allSatisfy({ $0 > 32 && $0 < 127 && $0 != 35 }), lines.count <= 129
        else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
        var headers: [[String]] = []
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
            let name = String(line[..<colon])
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            guard Self.validHeader(name, value) else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
            headers.append([name.lowercased(), value])
        }
        func values(_ name: String) -> [String] {
            headers.filter { $0[0] == name }.map { $0[1] }
        }
        let lengths = values("content-length")
        let encodings = values("transfer-encoding")
        guard values("host").count == 1, !values("host")[0].isEmpty,
              lengths.count <= 1, encodings.count <= 1, lengths.isEmpty || encodings.isEmpty,
              values("trailer").isEmpty,
              values("expect").isEmpty || values("expect") == ["100-continue"]
        else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
        let body: Body
        if let length = lengths.first {
            guard !length.isEmpty, length.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(length)
            else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
            body = .length(count)
        } else if let encoding = encodings.first {
            guard encoding.lowercased() == "chunked" else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
            body = .chunked
        } else { body = .length(0) }
        return Self(method: start[0], path: start[1], headers: headers, body: body)
    }

    func values(_ name: String) -> [String] {
        self.headers.filter { $0[0] == name }.map { $0[1] }
    }

    var isWebSocket: Bool {
        !self.values("upgrade").isEmpty
    }

    /// Only worker ingress and transfer resources are exposed, not the native node socket.
    var isWorkerHTTP: Bool {
        let path = self.path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        return [
            "/__openclaw__/worker-bundle/v1",
            "/__openclaw__/worker-transfer/v1",
            "/__openclaw__/worker-bootstrap",
        ].contains {
            path == $0 || path.hasPrefix($0 + "/")
        }
    }

    var forwardedHeaders: [[String]] {
        Self.endToEndHeaders(self.headers).filter { $0[0] != "expect" }
    }

    /// Removes nominated hop-by-hop fields as well as the standard hop header names.
    static func endToEndHeaders(_ headers: [[String]]) -> [[String]] {
        let nominated = headers.filter { $0[0].lowercased() == "connection" }.flatMap {
            $0[1].lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        let excluded = Self.hopHeaders.union(nominated)
        return headers.filter { !excluded.contains($0[0].lowercased()) }
    }

    static func token(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) ||
                "!#$%&'*+-.^_`|~".utf8.contains($0)
        }
    }

    static func validHeader(_ name: String, _ value: String) -> Bool {
        self.token(name) && value.utf8.allSatisfy { $0 == 9 || ($0 >= 32 && $0 != 127) }
    }
}

/// Streams both directions concurrently: a Gateway may reject an upload before its FIN.
enum MacNodeOpenClawIDBridgeHTTP {
    static func serve(
        request: MacNodeOpenClawIDBridgeRequest,
        reader: MacNodeOpenClawIDBridgeReader,
        io: MacNodeOpenClawIDBridgeIO,
        tunnel: OpenClawIDNodeTunnel) async throws
    {
        guard request.isWorkerHTTP, ["GET", "POST", "HEAD"].contains(request.method) else {
            try await io.write(Data("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8))
            return
        }
        let stream = try await OpenClawIDNodeHTTPStream.open(
            tunnel: tunnel, method: request.method, path: request.path, headers: request.forwardedHeaders)
        do {
            try await withTaskCancellationHandler {
                if request.values("expect") == ["100-continue"] {
                    try await io.write(Data("HTTP/1.1 100 Continue\r\n\r\n".utf8))
                }
                try await withThrowingTaskGroup(of: Bool.self) { group in
                    group.addTask {
                        try await Self.upload(request.body, reader: reader, stream: stream)
                        try await stream.finishBody()
                        return false
                    }
                    group.addTask {
                        try await Self.download(method: request.method, stream: stream, io: io)
                        return true
                    }
                    // A completed response owns shutdown even when the request body is incomplete.
                    defer { group.cancelAll()
                        io.interrupt()
                    }
                    do {
                        while let responseFinished = try await group.next() {
                            if responseFinished { await stream.cancel()
                                return
                            }
                        }
                    } catch {
                        // Cancel the stream before the task-group scope waits for its
                        // reader; responseHead may be awaiting an owner-held task.
                        await stream.cancel()
                        throw error
                    }
                }
            } onCancel: {
                io.interrupt()
                Task { await stream.cancel() }
            }
            await stream.cancel()
        } catch {
            await stream.cancel()
            throw error
        }
    }

    private static func upload(
        _ body: MacNodeOpenClawIDBridgeRequest.Body,
        reader: MacNodeOpenClawIDBridgeReader,
        stream: OpenClawIDNodeHTTPStream) async throws
    {
        switch body {
        case let .length(count): try await Self.copy(count, reader: reader, stream: stream)
        case .chunked:
            while true {
                let line = try await reader.through(Data([13, 10]), limit: 128)
                // The worker emits plain chunk sizes and no extensions or trailers.
                guard let size = String(bytes: line.dropLast(2), encoding: .utf8),
                      !size.isEmpty, size.utf8.allSatisfy({
                          (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
                      }), let count = Int(size, radix: 16)
                else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
                if count == 0 {
                    guard try await reader.exactly(2) == Data([13, 10]) else {
                        throw MacNodeOpenClawIDBridgeError.malformedRequest
                    }
                    return
                }
                try await Self.copy(count, reader: reader, stream: stream)
                guard try await reader.exactly(2) == Data([13, 10]) else {
                    throw MacNodeOpenClawIDBridgeError.malformedRequest
                }
            }
        }
    }

    private static func copy(
        _ count: Int, reader: MacNodeOpenClawIDBridgeReader, stream: OpenClawIDNodeHTTPStream) async throws
    {
        var remaining = count
        while remaining > 0 {
            let bytes = try await reader.portion(min(remaining, MacNodeOpenClawIDBridgeIO.blockBytes))
            try await stream.writeBody(bytes)
            remaining -= bytes.count
        }
    }

    private static func download(
        method: String, stream: OpenClawIDNodeHTTPStream, io: MacNodeOpenClawIDBridgeIO) async throws
    {
        let head = try await stream.responseHead()
        let response = try Self.responseHead(status: head.status, headers: head.headers, method: method)
        try await io.write(response.bytes)
        var remaining = response.length
        while let bytes = try await stream.nextBody() {
            if !response.noBody, !bytes.isEmpty {
                if let count = remaining {
                    guard bytes.count <= count else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
                    try await io.write(bytes)
                    remaining = count - bytes.count
                } else {
                    try await io.write(Data("\(String(bytes.count, radix: 16))\r\n".utf8) + bytes + Data([13, 10]))
                }
            }
        }
        if !response.noBody {
            if let remaining {
                guard remaining == 0 else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
            } else {
                try await io.write(Data("0\r\n\r\n".utf8))
            }
        }
    }

    struct ResponseHead {
        let bytes: Data
        let length: Int?
        let noBody: Bool
    }

    /// Validate remote headers before serializing: tunnel metadata must not inject HTTP lines.
    static func responseHead(status: Int, headers: [[String]], method: String) throws -> ResponseHead {
        guard (200...599).contains(status), headers.count <= 128,
              headers.allSatisfy({ $0.count == 2 && MacNodeOpenClawIDBridgeRequest.validHeader($0[0], $0[1]) })
        else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
        let noBody = method == "HEAD" || [204, 304].contains(status)
        let forwarded = MacNodeOpenClawIDBridgeRequest.endToEndHeaders(headers).filter {
            status != 204 || $0[0].lowercased() != "content-length"
        }
        let lengths = forwarded.filter { $0[0].lowercased() == "content-length" }.map { $0[1] }
        guard lengths.count <= 1 else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
        let length: Int?
        if let value = lengths.first {
            guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }), let count = Int(value)
            else { throw MacNodeOpenClawIDBridgeError.malformedRequest }
            length = count
        } else {
            length = nil
        }
        var text = "HTTP/1.1 \(status) Tunnel Response\r\nConnection: close\r\n"
        for pair in forwarded {
            text += "\(pair[0]): \(pair[1])\r\n"
        }
        if !noBody, length == nil { text += "Transfer-Encoding: chunked\r\n" }
        text += "\r\n"
        guard text.utf8.count <= MacNodeOpenClawIDBridgeRequest.maximumHeadBytes else {
            throw MacNodeOpenClawIDBridgeError.limitExceeded
        }
        return ResponseHead(bytes: Data(text.utf8), length: length, noBody: noBody)
    }
}
