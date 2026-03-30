import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

public enum SwabbleRuntimePaths {
    public static var appSupportDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/swabble", isDirectory: true)
    }

    public static var runtimeStatusFileURL: URL {
        appSupportDirectory.appendingPathComponent("runtime-status.json")
    }

    public static var cacheDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/swabble", isDirectory: true)
    }

    public static var controlSocketURL: URL {
        cacheDirectory.appendingPathComponent("control.sock")
    }

    public static var launchdPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.swabble.agent.plist")
    }
}

public struct RuntimeStatusSnapshot: Codable, Sendable, Equatable {
    public var wakeEnabled: Bool
    public var wakeWord: String
    public var lastWakeEventAt: Date?
    public var lastTranscriptAt: Date?
    public var currentAudioDevice: String
    public var loggingLevel: String
    public var loggingFormat: String
    public var loggingRedactPii: Bool
    public var updatedAt: Date

    public init(
        wakeEnabled: Bool,
        wakeWord: String,
        lastWakeEventAt: Date? = nil,
        lastTranscriptAt: Date? = nil,
        currentAudioDevice: String,
        loggingLevel: String,
        loggingFormat: String,
        loggingRedactPii: Bool,
        updatedAt: Date = Date())
    {
        self.wakeEnabled = wakeEnabled
        self.wakeWord = wakeWord
        self.lastWakeEventAt = lastWakeEventAt
        self.lastTranscriptAt = lastTranscriptAt
        self.currentAudioDevice = currentAudioDevice
        self.loggingLevel = loggingLevel
        self.loggingFormat = loggingFormat
        self.loggingRedactPii = loggingRedactPii
        self.updatedAt = updatedAt
    }
}

public actor RuntimeStatusStore {
    public static let shared = RuntimeStatusStore()

    private let fileURL: URL
    private var snapshot: RuntimeStatusSnapshot?

    public init(fileURL: URL = SwabbleRuntimePaths.runtimeStatusFileURL) {
        self.fileURL = fileURL
        if let data = try? Data(contentsOf: fileURL),
           let decoded = try? JSONDecoder().decode(RuntimeStatusSnapshot.self, from: data)
        {
            snapshot = decoded
        }
    }

    public func current() -> RuntimeStatusSnapshot? {
        snapshot
    }

    public func bootstrap(config: SwabbleConfig, currentAudioDevice: String, at now: Date = Date()) {
        var next = snapshot ?? RuntimeStatusSnapshot(
            wakeEnabled: config.wake.enabled,
            wakeWord: config.wake.word,
            currentAudioDevice: currentAudioDevice,
            loggingLevel: config.logging.level,
            loggingFormat: config.logging.format,
            loggingRedactPii: config.logging.redactPii,
            updatedAt: now)

        next.wakeEnabled = config.wake.enabled
        next.wakeWord = config.wake.word
        next.currentAudioDevice = currentAudioDevice
        next.loggingLevel = config.logging.level
        next.loggingFormat = config.logging.format
        next.loggingRedactPii = config.logging.redactPii
        next.updatedAt = now

        snapshot = next
        persist()
    }

    public func noteWakeEvent(at now: Date = Date()) {
        guard var current = snapshot else { return }
        current.lastWakeEventAt = now
        current.updatedAt = now
        snapshot = current
        persist()
    }

    public func noteTranscriptEvent(at now: Date = Date()) {
        guard var current = snapshot else { return }
        current.lastTranscriptAt = now
        current.updatedAt = now
        snapshot = current
        persist()
    }

    private func persist() {
        guard let snapshot else { return }

        let directory = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        if let data = try? encoder.encode(snapshot) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }
}

public func describeAudioDevice(from config: SwabbleConfig) -> String {
    if !config.audio.deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return config.audio.deviceName
    }
    if config.audio.deviceIndex >= 0 {
        return "index \(config.audio.deviceIndex)"
    }
    return "default"
}

public func isDaemonSocketRunning() -> Bool {
    let path = SwabbleRuntimePaths.controlSocketURL.path
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        return false
    }

    if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
       let kind = attrs[.type] as? FileAttributeType
    {
        guard kind == .typeSocket else { return false }
        return canConnectToUnixSocket(path: path)
    }

    return false
}

private func canConnectToUnixSocket(path: String) -> Bool {
    let fd = socket(AF_UNIX, Int32(SOCK_STREAM), 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)

    let copied = path.withCString { cPath in
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

    guard copied else { return false }

    let result = withUnsafePointer(to: &addr) { ptr -> Int32 in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }

    return result == 0
}
