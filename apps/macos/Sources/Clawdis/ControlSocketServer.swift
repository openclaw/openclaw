import ClawdisIPC
import Darwin
import Foundation
import OSLog

/// Lightweight UNIX-domain socket server so `clawdis-mac` can talk to the app
/// without a launchd MachService. Listens on `controlSocketPath`.
final actor ControlSocketServer {
    private nonisolated static let logger = Logger(subsystem: "com.steipete.clawdis", category: "control.socket")

    private var listenFD: Int32 = -1
    private var acceptTask: Task<Void, Never>?

    private let socketPath: String
    private let maxRequestBytes: Int
    private let allowedTeamIDs: Set<String>
    private let requestTimeoutSec: TimeInterval

    init(
        socketPath: String = controlSocketPath,
        maxRequestBytes: Int = 512 * 1024,
        allowedTeamIDs: Set<String> = ["Y5PE65HELJ"],
        requestTimeoutSec: TimeInterval = 5)
    {
        self.socketPath = socketPath
        self.maxRequestBytes = maxRequestBytes
        self.allowedTeamIDs = allowedTeamIDs
        self.requestTimeoutSec = requestTimeoutSec
    }

    private static func disableSigPipe(fd: Int32) {
        var one: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout.size(ofValue: one)))
    }

    func start() {
        // Already running
        guard self.listenFD == -1 else { return }

        let path = self.socketPath
        let fm = FileManager.default
        // Ensure directory exists
        let dir = (path as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        // Remove stale socket
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        let copied = path.withCString { cstr -> Int in
            strlcpy(&addr.sun_path.0, cstr, capacity)
        }
        if copied >= capacity {
            close(fd)
            return
        }
        addr.sun_len = UInt8(MemoryLayout.size(ofValue: addr))
        let len = socklen_t(MemoryLayout.size(ofValue: addr))
        if bind(fd, withUnsafePointer(to: &addr) { UnsafePointer<sockaddr>(OpaquePointer($0)) }, len) != 0 {
            close(fd)
            return
        }
        // Restrict permissions: owner rw
        chmod(path, S_IRUSR | S_IWUSR)
        if listen(fd, SOMAXCONN) != 0 {
            close(fd)
            return
        }

        self.listenFD = fd

        let allowedTeamIDs = self.allowedTeamIDs
        let maxRequestBytes = self.maxRequestBytes
        let requestTimeoutSec = self.requestTimeoutSec
        self.acceptTask = Task.detached(priority: .utility) {
            await Self.acceptLoop(
                listenFD: fd,
                allowedTeamIDs: allowedTeamIDs,
                maxRequestBytes: maxRequestBytes,
                requestTimeoutSec: requestTimeoutSec)
        }
    }

    func stop() {
        self.acceptTask?.cancel()
        self.acceptTask = nil
        if self.listenFD != -1 {
            close(self.listenFD)
            self.listenFD = -1
        }
        unlink(self.socketPath)
    }

    private nonisolated static func acceptLoop(
        listenFD: Int32,
        allowedTeamIDs: Set<String>,
        maxRequestBytes: Int,
        requestTimeoutSec: TimeInterval) async
    {
        while !Task.isCancelled {
            var addr = sockaddr()
            var len = socklen_t(MemoryLayout<sockaddr>.size)
            let client = accept(listenFD, &addr, &len)
            if client < 0 {
                if errno == EINTR { continue }
                // Socket was likely closed as part of stop().
                if errno == EBADF || errno == EINVAL { return }
                self.logger.error("accept failed: \(errno, privacy: .public)")
                try? await Task.sleep(nanoseconds: 50_000_000)
                continue
            }

            Self.disableSigPipe(fd: client)
            Task.detached(priority: .utility) {
                defer { close(client) }
                await Self.handleClient(
                    fd: client,
                    allowedTeamIDs: allowedTeamIDs,
                    maxRequestBytes: maxRequestBytes,
                    requestTimeoutSec: requestTimeoutSec)
            }
        }
    }

    private nonisolated static func handleClient(
        fd: Int32,
        allowedTeamIDs: Set<String>,
        maxRequestBytes: Int,
        requestTimeoutSec: TimeInterval) async
    {
        guard self.isAllowed(fd: fd, allowedTeamIDs: allowedTeamIDs) else {
            return
        }

        do {
            guard let request = try self.readRequest(
                fd: fd,
                maxRequestBytes: maxRequestBytes,
                timeoutSec: requestTimeoutSec)
            else {
                return
            }

            let response = try await ControlRequestHandler.process(request: request)
            try self.writeResponse(fd: fd, response: response)
        } catch {
            self.logger.error("socket request failed: \(error.localizedDescription, privacy: .public)")
            let resp = Response(ok: false, message: "socket error: \(error.localizedDescription)")
            try? self.writeResponse(fd: fd, response: resp)
        }
    }

    private nonisolated static func readRequest(
        fd: Int32,
        maxRequestBytes: Int,
        timeoutSec: TimeInterval) throws -> Request?
    {
        let deadline = Date().addingTimeInterval(timeoutSec)
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        let bufferSize = buffer.count
        let decoder = JSONDecoder()

        while true {
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 {
                throw POSIXError(.ETIMEDOUT)
            }

            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let sliceMs = max(1.0, min(remaining, 0.25) * 1000.0)
            let polled = poll(&pfd, 1, Int32(sliceMs))
            if polled == 0 { continue }
            if polled < 0 {
                if errno == EINTR { continue }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }

            let n = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!, bufferSize) }
            if n > 0 {
                data.append(buffer, count: n)
                if data.count > maxRequestBytes {
                    throw POSIXError(.EMSGSIZE)
                }
                if let req = try? decoder.decode(Request.self, from: data) {
                    return req
                }
                continue
            }

            if n == 0 {
                return data.isEmpty ? nil : try decoder.decode(Request.self, from: data)
            }

            if errno == EINTR { continue }
            if errno == EAGAIN { continue }
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
    }

    private nonisolated static func writeResponse(fd: Int32, response: Response) throws {
        let encoded = try JSONEncoder().encode(response)
        try encoded.withUnsafeBytes { buf in
            guard let base = buf.baseAddress else { return }
            var written = 0
            while written < encoded.count {
                let n = write(fd, base.advanced(by: written), encoded.count - written)
                if n > 0 {
                    written += n
                    continue
                }
                if n == -1, errno == EINTR { continue }
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }
    }

    private nonisolated static func isAllowed(fd: Int32, allowedTeamIDs: Set<String>) -> Bool {
        var pid: pid_t = 0
        var pidSize = socklen_t(MemoryLayout<pid_t>.size)
        let r = getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &pidSize)
        guard r == 0, pid > 0 else { return false }

        // Always require a valid code signature match (TeamID).
        // This prevents any same-UID process from driving the app's privileged surface.
        if self.teamIDMatches(pid: pid, allowedTeamIDs: allowedTeamIDs) {
            return true
        }

        #if DEBUG
        // Debug-only escape hatch: allow unsigned/same-UID clients when explicitly opted in.
        // This keeps local development workable (e.g. a SwiftPM-built `clawdis-mac` binary).
        let env = ProcessInfo.processInfo.environment["CLAWDIS_ALLOW_UNSIGNED_SOCKET_CLIENTS"]
        if env == "1", let callerUID = self.uid(for: pid), callerUID == getuid() {
            self.logger.warning(
                "allowing unsigned same-UID socket client pid=\(pid, privacy: .public) due to CLAWDIS_ALLOW_UNSIGNED_SOCKET_CLIENTS=1")
            return true
        }
        #endif

        if let callerUID = self.uid(for: pid) {
            self.logger.error(
                "socket client rejected pid=\(pid, privacy: .public) uid=\(callerUID, privacy: .public)")
        } else {
            self.logger.error("socket client rejected pid=\(pid, privacy: .public) (uid unknown)")
        }
        return false
    }

    private nonisolated static func uid(for pid: pid_t) -> uid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout.size(ofValue: info)
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        let ok = mib.withUnsafeMutableBufferPointer { mibPtr -> Bool in
            return sysctl(mibPtr.baseAddress, u_int(mibPtr.count), &info, &size, nil, 0) == 0
        }
        return ok ? info.kp_eproc.e_ucred.cr_uid : nil
    }

    private nonisolated static func teamIDMatches(pid: pid_t, allowedTeamIDs: Set<String>) -> Bool {
        let attrs: NSDictionary = [kSecGuestAttributePid: pid]
        var secCode: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attrs, SecCSFlags(), &secCode) == errSecSuccess,
              let code = secCode else { return false }

        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let sCode = staticCode else { return false }

        var infoCF: CFDictionary?
        guard SecCodeCopySigningInformation(sCode, SecCSFlags(), &infoCF) == errSecSuccess,
              let info = infoCF as? [String: Any],
              let teamID = info[kSecCodeInfoTeamIdentifier as String] as? String
        else {
            return false
        }

        return allowedTeamIDs.contains(teamID)
    }
}
