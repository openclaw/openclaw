import ClawdisIPC
import Foundation
import Darwin

/// Lightweight UNIX-domain socket server so `clawdis-mac` can talk to the app
/// without a launchd MachService. Listens on `controlSocketPath`.
final actor ControlSocketServer {
    private var listenFD: Int32 = -1
    private var source: DispatchSourceRead?
    private let maxRequestBytes = 512 * 1024

    func start() {
        // Already running
        guard self.listenFD == -1 else { return }

        let path = controlSocketPath
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
        if bind(fd, withUnsafePointer(to: &addr, { UnsafePointer<sockaddr>(OpaquePointer($0)) }), len) != 0 {
            close(fd)
            return
        }
        // Restrict permissions: owner rw
        chmod(path, S_IRUSR | S_IWUSR)
        if listen(fd, SOMAXCONN) != 0 {
            close(fd)
            return
        }

        let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .global(qos: .utility))
        src.setEventHandler { [weak self] in
            guard let self else { return }
            Task { await self.acceptConnection(listenFD: fd) }
        }
        src.setCancelHandler { close(fd) }
        src.resume()

        self.listenFD = fd
        self.source = src
    }

    func stop() {
        self.source?.cancel()
        self.source = nil
        if self.listenFD != -1 {
            close(self.listenFD)
            self.listenFD = -1
        }
        unlink(controlSocketPath)
    }

    private func acceptConnection(listenFD: Int32) {
        var addr = sockaddr()
        var len: socklen_t = socklen_t(MemoryLayout<sockaddr>.size)
        let client = accept(listenFD, &addr, &len)
        guard client >= 0 else { return }
        Task.detached { [weak self] in
            defer { close(client) }
            guard let self else { return }
            await self.handleClient(fd: client)
        }
    }

    private func handleClient(fd: Int32) async {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        let bufSize = buffer.count
        while true {
            let readCount = buffer.withUnsafeMutableBytes {
                read(fd, $0.baseAddress!, bufSize)
            }
            if readCount > 0 {
                data.append(buffer, count: readCount)
                if data.count > self.maxRequestBytes { return }
            } else {
                break
            }
        }

        guard !data.isEmpty else { return }

        do {
            let request = try JSONDecoder().decode(Request.self, from: data)
            let response = try await ControlRequestHandler.process(request: request)
            let encoded = try JSONEncoder().encode(response)
            _ = encoded.withUnsafeBytes { ptr in
                write(fd, ptr.baseAddress!, encoded.count)
            }
        } catch {
            let resp = Response(ok: false, message: "socket error: \(error.localizedDescription)")
            if let encoded = try? JSONEncoder().encode(resp) {
                _ = encoded.withUnsafeBytes { ptr in
                    write(fd, ptr.baseAddress!, encoded.count)
                }
            }
        }
    }
}
