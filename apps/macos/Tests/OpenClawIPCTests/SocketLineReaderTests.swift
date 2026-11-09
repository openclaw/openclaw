import Darwin
import Testing
@testable import OpenClaw

struct SocketLineReaderTests {
    /// Writes `bytes` (then closes) on one end of a socket pair and reads a line from the other.
    private func read(_ bytes: [UInt8]) throws -> String? {
        var fds: [Int32] = [0, 0]
        try #require(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
        defer { close(fds[0]) }
        if !bytes.isEmpty {
            _ = bytes.withUnsafeBytes { send(fds[1], $0.baseAddress, $0.count, 0) }
        }
        close(fds[1])
        return try readLineFromSocket(fds[0], maxBytes: 1024)
    }

    @Test func `a clean close reads as no line`() throws {
        #expect(try self.read([]) == nil)
    }

    @Test func `a valid frame reads as its line`() throws {
        #expect(try self.read(Array("{\"ok\":true}\n".utf8)) == "{\"ok\":true}")
    }

    // Callers answer a thrown frame with invalid_request instead of waiting for a timeout.
    @Test func `a frame that is not utf8 is an error, not a clean close`() {
        #expect(throws: SocketLineEncodingError.self) { try self.read([0xFF, 0xFE, 0x0A]) }
    }
}
