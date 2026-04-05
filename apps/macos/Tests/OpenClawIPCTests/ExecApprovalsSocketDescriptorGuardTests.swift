import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalsSocketDescriptorGuardTests {
    @Test func `suppress sigpipe enables SO_NOSIGPIPE on unix sockets`() throws {
        var fds = [Int32](repeating: -1, count: 2)
        let result = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
        #expect(result == 0)
        guard result == 0 else { return }
        defer {
            for fd in fds where fd >= 0 {
                close(fd)
            }
        }

        try ExecApprovalsSocketDescriptorGuard.suppressSigPipe(for: fds[0])

        var enabled: Int32 = 0
        var length = socklen_t(MemoryLayout.size(ofValue: enabled))
        #expect(
            getsockopt(
                fds[0],
                SOL_SOCKET,
                SO_NOSIGPIPE,
                &enabled,
                &length) == 0)
        #expect(enabled == 1)
    }
}
