import ConcurrencyExtras
import CoreFoundation
import Foundation

enum MacNodeClaudeSessionCatalogContract {
    static let pluginId = "anthropic"
    static let capability = "claude-sessions"
    static let listCommand = "anthropic.claude.sessions.list.v1"
    static let readCommand = "anthropic.claude.sessions.read.v1"
    static let commands = [listCommand, readCommand]
}

enum MacNodeClaudeSessionCatalog {
    enum CatalogError: LocalizedError, Equatable {
        case invalidParams(String)
        case unavailable
        case responseTooLarge

        var errorDescription: String? {
            switch self {
            case let .invalidParams(message):
                "INVALID_REQUEST: \(message)"
            case .unavailable:
                "UNAVAILABLE: Claude session catalog is unavailable"
            case .responseTooLarge:
                "UNAVAILABLE: Claude session item exceeded the size limit"
            }
        }

        var isInvalidRequest: Bool {
            if case .invalidParams = self {
                return true
            }
            return false
        }
    }

    private struct ListParams {
        var cursor: String?
        var limit = 50
        var searchTerm: String?
    }

    private struct ReadParams {
        var threadId: String
        var cursor: String?
        var limit = 20
    }

    private struct TranscriptCursor {
        var offset: Int
        var leaseId: String?
    }

    private struct SessionRecord {
        var threadId: String
        var name: String?
        var cwd: String?
        var createdAt: Int64?
        var updatedAt: Int64?
        var source: String
        var gitBranch: String?
        var fileURL: URL

        var wire: [String: Any] {
            var value: [String: Any] = [
                "threadId": threadId,
                "status": "stored",
                "source": source,
                "modelProvider": "anthropic",
                "archived": false,
            ]
            value["name"] = self.name ?? NSNull()
            value["cwd"] = self.cwd
            value["createdAt"] = self.createdAt
            value["updatedAt"] = self.updatedAt
            value["recencyAt"] = self.updatedAt
            value["gitBranch"] = self.gitBranch
            return value
        }
    }

    private struct CatalogFileIdentity: Equatable {
        var modificationDate: Date
        var size: UInt64
        var inode: UInt64
    }

    private struct CatalogDiscoveryCacheEntry {
        var rootPath: String
        var identity: CatalogFileIdentity
        var sessionId: String
        var scannedBytes: Int
        var record: SessionRecord?
        var sidechain: Bool
    }

    private struct CLIRecordInspection {
        var aiTitle: String?
        var record: SessionRecord?
        var sidechain = false
        var shouldStop = false
    }

    private struct CLIRecordDiscoveryContext {
        var projectsURL: URL
        var resolvedProjectsURL: URL
        var rootPath: String
    }

    private struct CLIRecordFileScan {
        var fileBytes: Int
        var record: SessionRecord?
        var sidechain: Bool
        var cacheable: Bool
    }

    private struct TranscriptReadLease {
        var rootPath: String
        var threadId: String
        var fileURL: URL
        var expiresAt: Date
    }

    private final class CatalogCache<Value>: @unchecked Sendable {
        private struct Entry {
            var value: Value
            var generation: UInt64
        }

        private let lock = NSLock()
        private let limit: Int
        private var entries: [String: Entry] = [:]
        private var generation: UInt64 = 0

        init(limit: Int) {
            self.limit = limit
        }

        func lookup(
            key: String,
            removeInvalid: Bool = false,
            matches: (Value) -> Bool) -> Value?
        {
            self.lock.lock()
            defer { self.lock.unlock() }
            guard var entry = self.entries[key], matches(entry.value) else {
                if removeInvalid { self.entries.removeValue(forKey: key) }
                return nil
            }
            self.generation &+= 1
            entry.generation = self.generation
            self.entries[key] = entry
            return entry.value
        }

        func store(key: String, makeValue: () -> Value) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.generation &+= 1
            self.entries[key] = Entry(value: makeValue(), generation: self.generation)
            if self.entries.count > self.limit,
               let oldest = self.entries.min(by: { $0.value.generation < $1.value.generation })
            {
                self.entries.removeValue(forKey: oldest.key)
            }
        }

        func remove(key: String) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.entries.removeValue(forKey: key)
        }

        func remove(where predicate: (String, Value) -> Bool) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.entries = self.entries.filter { !predicate($0.key, $0.value.value) }
        }
    }

    private static let defaultPageLimit = 50
    private static let maxPageLimit = 100
    private static let defaultReadLimit = 20
    private static let maxReadLimit = 50
    private static let maxCursorLength = 256
    private static let maxSessionIdLength = 256
    private static let maxSearchLength = 500
    private static let maxCatalogDiscoveryFiles = 10000
    fileprivate static let maxCatalogDiscoveryCacheEntries = 20000
    private static let maxTranscriptReadLeases = 256
    private static let transcriptReadLeaseLifetimeSeconds: TimeInterval = 120
    private static let metadataPrefixBytes = 1024 * 1024
    private static let metadataReadChunkBytes = 16 * 1024
    private static let maxCatalogMetadataScanBytes = 64 * 1024 * 1024
    private static let readChunkBytes = 128 * 1024
    private static let maxTranscriptScanBytes = 64 * 1024 * 1024
    private static let maxTranscriptItemBytes = 4 * 1024 * 1024
    private static let maxTranscriptPageBytes = 20 * 1024 * 1024
    private static let maxTruncatedTranscriptTextBytes = 512 * 1024
    private static let cliEntrypoints: Set<String> = ["cli", "sdk-cli"]
    private static let iso8601FractionalStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let iso8601Style = Date.ISO8601FormatStyle()
    private static let catalogDiscoveryCache = CatalogCache<CatalogDiscoveryCacheEntry>(
        limit: maxCatalogDiscoveryCacheEntries)
    private static let transcriptReadLeases = CatalogCache<TranscriptReadLease>(limit: maxTranscriptReadLeases)
    private static let catalogEnumerationObserver = LockIsolated<(@Sendable (String) -> Void)?>(nil)

    static func setCatalogEnumerationObserverForTesting(
        _ observer: (@Sendable (String) -> Void)?)
    {
        self.catalogEnumerationObserver.setValue(observer)
    }

    static func shouldAdvertise(
        root: [String: Any]? = nil,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool
    {
        let root = root ?? OpenClawConfigFile.loadDict()
        guard OpenClawConfigFile.defaultEnabledBundledPluginAllowed(
            MacNodeClaudeSessionCatalogContract.pluginId,
            root: root)
        else { return false }
        let pluginConfig = OpenClawConfigFile.pluginEntry(
            MacNodeClaudeSessionCatalogContract.pluginId,
            root: root)?["config"] as? [String: Any]
        let sessionCatalog = pluginConfig?["sessionCatalog"] as? [String: Any]
        if let enabled = sessionCatalog?["enabled"] as? NSNumber,
           CFGetTypeID(enabled) == CFBooleanGetTypeID(), !enabled.boolValue
        {
            return false
        }
        let projectsURL = self.projectsURL(homeURL: homeURL, environment: environment)
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(
            atPath: projectsURL.path,
            isDirectory: &isDirectory) && isDirectory.boolValue
    }

    static func list(
        paramsJSON: String?,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment) throws -> String
    {
        try Task.checkCancellation()
        let params = try decodeListParams(paramsJSON)
        let offset = try decodeCursor(params.cursor, label: "catalog")
        let search = params.searchTerm?.lowercased()
        let projectsURL = self.projectsURL(homeURL: homeURL, environment: environment)
        let records = try sessions(homeURL: homeURL, projectsURL: projectsURL).filter { record in
            guard let search else { return true }
            return [record.name, record.cwd, record.gitBranch, record.threadId]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(search) }
        }
        guard offset <= records.count else {
            throw CatalogError.invalidParams("catalog cursor is invalid")
        }
        let end = min(records.count, offset + params.limit)
        let page = records[offset..<end].map(\.wire)
        var response: [String: Any] = ["sessions": page]
        if end < records.count {
            response["nextCursor"] = try encodeCursor(end)
        }
        return try encode(response, maxBytes: self.maxTranscriptPageBytes)
    }

    static func read(
        paramsJSON: String?,
        homeURL: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment) throws -> String
    {
        try Task.checkCancellation()
        let params = try decodeReadParams(paramsJSON)
        let cursor = try params.cursor.map(self.decodeTranscriptCursor)
        let projectsURL = self.projectsURL(homeURL: homeURL, environment: environment)
        guard let target = try sessionFileForRead(
            homeURL: homeURL,
            projectsURL: projectsURL,
            threadId: params.threadId,
            leaseId: cursor?.leaseId)
        else { throw CatalogError.invalidParams("Claude session is unavailable") }
        let fileURL = target.fileURL

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let fileSize = try handle.seekToEnd()
        let end = UInt64(cursor?.offset ?? Int(fileSize))
        guard end <= fileSize else {
            throw CatalogError.invalidParams("transcript cursor is invalid")
        }

        var position = end
        var scanned = 0
        var fragments: [Data] = []
        var found: [(item: [String: Any], start: UInt64, end: UInt64)] = []
        func appendLine(prefix: Data, start: UInt64) {
            var line = Data(capacity: prefix.count + fragments.reduce(0) { $0 + $1.count })
            line.append(prefix)
            for fragment in fragments.reversed() {
                line.append(fragment)
            }
            fragments.removeAll(keepingCapacity: true)
            if let item = parseTranscriptLine(line) {
                found.append((item, start, start + UInt64(line.count)))
            }
        }
        while position > 0,
              scanned < self.maxTranscriptScanBytes,
              found.count <= params.limit
        {
            try Task.checkCancellation()
            let size = min(
                readChunkBytes,
                Int(position),
                maxTranscriptScanBytes - scanned)
            position -= UInt64(size)
            try handle.seek(toOffset: position)
            guard let chunk = try handle.read(upToCount: size), chunk.count == size else {
                throw CatalogError.unavailable
            }
            scanned += chunk.count
            let bytes = [UInt8](chunk)
            var right = bytes.count
            if !bytes.isEmpty {
                for index in stride(from: bytes.count - 1, through: 0, by: -1) where bytes[index] == 0x0A {
                    let segment = chunk.subdata(in: (index + 1)..<right)
                    if !segment.isEmpty || !fragments.isEmpty {
                        appendLine(prefix: segment, start: position + UInt64(index + 1))
                        if found.count > params.limit {
                            break
                        }
                    }
                    right = index
                }
            }
            if found.count > params.limit {
                break
            }
            let prefix = chunk.subdata(in: 0..<right)
            if position == 0 {
                if !prefix.isEmpty || !fragments.isEmpty {
                    appendLine(prefix: prefix, start: 0)
                }
            } else if !prefix.isEmpty {
                fragments.append(prefix)
            }
        }
        if position > 0, found.count < params.limit {
            throw CatalogError.responseTooLarge
        }
        let requested = Array(found.prefix(params.limit))
        var selected: [(item: [String: Any], start: UInt64, end: UInt64)] = []
        var selectedBytes = 0
        for entry in requested {
            try Task.checkCancellation()
            guard let data = try? JSONSerialization.data(withJSONObject: entry.item) else { continue }
            if !selected.isEmpty,
               selectedBytes + data.count > self.maxTranscriptPageBytes - 64 * 1024
            {
                break
            }
            selected.append(entry)
            selectedBytes += data.count
        }
        let hasEarlierItems = selected.count < found.count || position > 0
        let leaseId = target.leaseId ?? UUID().uuidString
        if target.leaseId == nil {
            self.transcriptReadLeases.store(key: leaseId) {
                TranscriptReadLease(
                    rootPath: projectsURL.standardizedFileURL.path,
                    threadId: params.threadId,
                    fileURL: fileURL,
                    expiresAt: Date().addingTimeInterval(self.transcriptReadLeaseLifetimeSeconds))
            }
        }
        var response: [String: Any] = try [
            "threadId": params.threadId,
            // Shared UI expects newest-first pages and restores chronological order.
            "items": selected.map { entry in
                var item = entry.item
                // Mixed-block pages can resume even the only row. Preserve its byte
                // end and discovery lease across appends and changed page sizes.
                item["resumeCursor"] = try encodeTranscriptCursor(offset: Int(entry.end), leaseId: leaseId)
                return item
            },
        ]
        if hasEarlierItems, let earliest = selected.last?.start, earliest > 0 {
            response["nextCursor"] = try encodeTranscriptCursor(
                offset: Int(earliest),
                leaseId: leaseId)
        }
        return try encode(response)
    }
}

extension MacNodeClaudeSessionCatalog {
    private static func projectsURL(homeURL: URL, environment: [String: String]) -> URL {
        // Claude Code's "Respect CLAUDE_CONFIG_DIR everywhere" replaces ~/.claude;
        // Desktop metadata stays HOME/Library-scoped, matching the TS scan.
        let configured = environment["CLAUDE_CONFIG_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        let configDir = if let configured, !configured.isEmpty {
            URL(filePath: configured, directoryHint: .isDirectory).absoluteURL
        } else {
            homeURL.appending(path: ".claude", directoryHint: .isDirectory)
        }
        return configDir.appending(path: "projects", directoryHint: .isDirectory)
    }

    private static func desktopSessionsURL(homeURL: URL) -> URL {
        homeURL.appending(
            path: "Library/Application Support/Claude/claude-code-sessions",
            directoryHint: .isDirectory)
    }

    private static func childDirectories(_ root: URL) -> [URL] {
        let keys: [URLResourceKey] = [.isDirectoryKey]
        return ((try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: keys,
            options: [.skipsHiddenFiles])) ?? []).filter { url in
            (try? url.resourceValues(forKeys: Set(keys)).isDirectory) == true
        }
    }

    private static func readJSON(_ url: URL) -> Any? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func catalogFileIdentity(_ url: URL) -> CatalogFileIdentity? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let modificationDate = attributes[.modificationDate] as? Date,
              let size = (attributes[.size] as? NSNumber)?.uint64Value,
              let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value
        else { return nil }
        return CatalogFileIdentity(modificationDate: modificationDate, size: size, inode: inode)
    }

    private static func string(_ value: Any?, maxLength: Int = 4096) -> String? {
        guard let raw = value as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value.utf8.count > maxLength ? nil : value
    }

    private static func timestampMs(_ value: Any?) -> Int64? {
        if let value = value as? NSNumber {
            return value.int64Value
        }
        guard let value = value as? String else { return nil }
        guard let date = (try? iso8601FractionalStyle.parse(value)) ?? (try? iso8601Style.parse(value))
        else { return nil }
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    private static func isWithin(_ root: URL, candidate: URL) -> Bool {
        let rootPath = root.standardizedFileURL.path
        let candidatePath = candidate.standardizedFileURL.path
        return candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/")
    }

    private static func safeSessionFile(
        root: URL,
        resolvedRoot: URL,
        candidate: URL,
        sessionId: String) -> URL?
    {
        guard self.isWithin(root, candidate: candidate),
              candidate.lastPathComponent == "\(sessionId).jsonl"
        else { return nil }
        let resolvedCandidate = candidate.resolvingSymlinksInPath()
        var isDirectory: ObjCBool = false
        guard self.isWithin(resolvedRoot, candidate: resolvedCandidate),
              FileManager.default.fileExists(
                  atPath: resolvedCandidate.path,
                  isDirectory: &isDirectory),
              !isDirectory.boolValue
        else { return nil }
        return resolvedCandidate
    }

    private static func revalidatedSessionFile(
        projectsURL: URL,
        threadId: String,
        candidate: URL) -> URL?
    {
        let resolvedRoot = projectsURL.resolvingSymlinksInPath()
        guard let fileURL = self.safeSessionFile(
            root: resolvedRoot,
            resolvedRoot: resolvedRoot,
            candidate: candidate,
            sessionId: threadId),
            FileManager.default.isReadableFile(atPath: fileURL.path)
        else { return nil }
        return fileURL
    }

    private static func sessionFileForRead(
        homeURL: URL,
        projectsURL: URL,
        threadId: String,
        leaseId: String?) throws -> (fileURL: URL, leaseId: String?)?
    {
        let rootPath = projectsURL.standardizedFileURL.path
        if let leaseId {
            if let candidate = self.transcriptReadLeases.lookup(key: leaseId, removeInvalid: true, matches: {
                $0.rootPath == rootPath && $0.threadId == threadId && $0.expiresAt > Date()
            })?.fileURL,
                let fileURL = self.revalidatedSessionFile(
                    projectsURL: projectsURL,
                    threadId: threadId,
                    candidate: candidate)
            {
                return (fileURL, leaseId)
            }
            // A lease is only an optimization. App restart, expiry, eviction, or
            // a moved file must fall back to current eligibility discovery.
            self.transcriptReadLeases.remove(key: leaseId)
        }

        guard let candidate = try self.sessions(homeURL: homeURL, projectsURL: projectsURL)
            .first(where: { $0.threadId == threadId })?.fileURL
        else { return nil }
        guard let fileURL = self.revalidatedSessionFile(
            projectsURL: projectsURL,
            threadId: threadId,
            candidate: candidate)
        else { return nil }
        return (fileURL, nil)
    }

    private static func desktopMetadata(homeURL: URL) throws -> (
        active: [String: [String: Any]],
        archived: Set<String>)
    {
        var active: [String: [String: Any]] = [:]
        var archived = Set<String>()
        for accountURL in self.childDirectories(self.desktopSessionsURL(homeURL: homeURL)) {
            try Task.checkCancellation()
            for workspaceURL in self.childDirectories(accountURL) {
                try Task.checkCancellation()
                let files = (try? FileManager.default.contentsOfDirectory(
                    at: workspaceURL,
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles])) ?? []
                for fileURL in files
                    where fileURL.lastPathComponent.hasPrefix("local_") &&
                    fileURL.pathExtension == "json"
                {
                    try Task.checkCancellation()
                    guard let metadata = self.readJSON(fileURL) as? [String: Any],
                          let sessionId = self.string(metadata["cliSessionId"], maxLength: 256)
                    else { continue }
                    if (metadata["isArchived"] as? Bool) == true {
                        archived.insert(sessionId)
                        active.removeValue(forKey: sessionId)
                    } else if !archived.contains(sessionId) {
                        active[sessionId] = metadata
                    }
                }
            }
        }
        return (active, archived)
    }

    private static func discoverCLIRecords(
        projectsURL: URL,
        resolvedProjectsURL: URL,
        projectFiles: [[URL]],
        records: inout [String: SessionRecord],
        sidechainIds: inout Set<String>) throws
    {
        var discoveredFiles = 0
        var scannedBytes = 0
        var truncated = false
        var seenPaths = Set<String>()
        let context = CLIRecordDiscoveryContext(
            projectsURL: projectsURL,
            resolvedProjectsURL: resolvedProjectsURL,
            rootPath: projectsURL.path)
        scan: for files in projectFiles {
            try Task.checkCancellation()
            for candidate in files where candidate.pathExtension == "jsonl" {
                try Task.checkCancellation()
                guard discoveredFiles < self.maxCatalogDiscoveryFiles else {
                    truncated = true
                    break scan
                }
                discoveredFiles += 1
                if try self.discoverCLIRecord(
                    candidate: candidate,
                    context: context,
                    scannedBytes: &scannedBytes,
                    seenPaths: &seenPaths,
                    records: &records,
                    sidechainIds: &sidechainIds)
                {
                    truncated = true
                    break scan
                }
            }
        }
        if !truncated {
            self.catalogDiscoveryCache.remove { path, entry in
                entry.rootPath == context.rootPath && !seenPaths.contains(path)
            }
        }
    }

    private static func discoverCLIRecord(
        candidate: URL,
        context: CLIRecordDiscoveryContext,
        scannedBytes: inout Int,
        seenPaths: inout Set<String>,
        records: inout [String: SessionRecord],
        sidechainIds: inout Set<String>) throws -> Bool
    {
        let sessionId = candidate.deletingPathExtension().lastPathComponent
        guard !sessionId.isEmpty,
              records[sessionId] == nil,
              !sidechainIds.contains(sessionId),
              let fileURL = self.safeSessionFile(
                  root: context.projectsURL,
                  resolvedRoot: context.resolvedProjectsURL,
                  candidate: candidate,
                  sessionId: sessionId)
        else { return false }
        let identity = self.catalogFileIdentity(fileURL)
        let cachePath = fileURL.path
        seenPaths.insert(cachePath)
        // Cache identity does not encode ACLs. Preserve open-on-every-list authorization.
        guard FileManager.default.isReadableFile(atPath: cachePath) else { return false }
        if let identity,
           let cached = self.catalogDiscoveryCache.lookup(key: cachePath, matches: {
               $0.rootPath == context.rootPath && $0.identity == identity && $0.sessionId == sessionId
           }),
           scannedBytes + cached.scannedBytes <= self.maxCatalogMetadataScanBytes
        {
            if cached.sidechain {
                sidechainIds.insert(sessionId)
            }
            if let record = cached.record {
                records[sessionId] = record
            }
            // Preserve the cold-scan byte frontier so repeated pagination stays stable.
            scannedBytes += cached.scannedBytes
            return scannedBytes >= self.maxCatalogMetadataScanBytes
        }
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return false }
        defer { try? handle.close() }
        let updatedAt = identity.map {
            Int64($0.modificationDate.timeIntervalSince1970 * 1000)
        } ?? (try? fileURL.resourceValues(
            forKeys: [.contentModificationDateKey]).contentModificationDate)
            .map { Int64($0.timeIntervalSince1970 * 1000) }
        let scan = try self.scanCLIRecordFile(
            handle: handle,
            fileURL: fileURL,
            sessionId: sessionId,
            updatedAt: updatedAt,
            byteLimit: self.maxCatalogMetadataScanBytes - scannedBytes)
        scannedBytes += scan.fileBytes
        if scan.sidechain {
            sidechainIds.insert(sessionId)
        }
        if let record = scan.record {
            records[sessionId] = record
        }
        let budgetConstrained = scannedBytes >= self.maxCatalogMetadataScanBytes
        if let identity, !budgetConstrained, scan.cacheable {
            self.catalogDiscoveryCache.store(key: cachePath) {
                CatalogDiscoveryCacheEntry(
                    rootPath: context.rootPath,
                    identity: identity,
                    sessionId: sessionId,
                    scannedBytes: scan.fileBytes,
                    record: scan.record,
                    sidechain: scan.sidechain)
            }
        }
        return budgetConstrained
    }

    private static func scanCLIRecordFile(
        handle: FileHandle,
        fileURL: URL,
        sessionId: String,
        updatedAt: Int64?,
        byteLimit: Int) throws -> CLIRecordFileScan
    {
        var inspection = CLIRecordInspection()
        var pending = Data()
        var fileBytes = 0
        var reachedEnd = false
        var readFailed = false
        while !inspection.shouldStop,
              fileBytes < self.metadataPrefixBytes,
              fileBytes < byteLimit
        {
            try Task.checkCancellation()
            let size = min(
                self.metadataReadChunkBytes,
                self.metadataPrefixBytes - fileBytes,
                byteLimit - fileBytes)
            guard size > 0 else { break }
            guard let chunk = try? handle.read(upToCount: size) else {
                pending.removeAll()
                readFailed = true
                break
            }
            if chunk.isEmpty {
                reachedEnd = true
                break
            }
            fileBytes += chunk.count
            pending.append(chunk)
            while !inspection.shouldStop, let newline = pending.firstIndex(of: 0x0A) {
                self.inspectCLIRecordLine(
                    Data(pending[..<newline]),
                    sessionId: sessionId,
                    fileURL: fileURL,
                    updatedAt: updatedAt,
                    inspection: &inspection)
                pending.removeSubrange(...newline)
            }
        }
        if !inspection.shouldStop, reachedEnd, !pending.isEmpty {
            self.inspectCLIRecordLine(
                pending,
                sessionId: sessionId,
                fileURL: fileURL,
                updatedAt: updatedAt,
                inspection: &inspection)
        }
        return CLIRecordFileScan(
            fileBytes: fileBytes,
            record: inspection.record,
            sidechain: inspection.sidechain,
            cacheable: !readFailed &&
                (inspection.shouldStop || reachedEnd || fileBytes >= self.metadataPrefixBytes))
    }

    private static func isCLIEntrypoint(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return self.cliEntrypoints.contains(value)
    }

    private static func inspectCLIRecordLine(
        _ line: Data,
        sessionId: String,
        fileURL: URL,
        updatedAt: Int64?,
        inspection: inout CLIRecordInspection)
    {
        guard let row = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              self.string(row["sessionId"], maxLength: self.maxSessionIdLength) == sessionId
        else { return }
        if row["type"] as? String == "ai-title" {
            inspection.aiTitle = self.string(row["aiTitle"], maxLength: 500) ?? inspection.aiTitle
            return
        }
        if let entrypoint = row["entrypoint"] as? String,
           !self.isCLIEntrypoint(entrypoint)
        {
            inspection.shouldStop = true
            return
        }
        if self.isCLIEntrypoint(row["entrypoint"]),
           (row["isSidechain"] as? Bool) == true
        {
            inspection.sidechain = true
            inspection.shouldStop = true
            return
        }
        guard self.isCLIEntrypoint(row["entrypoint"]),
              row["type"] as? String == "user",
              row["isMeta"] as? Bool != true,
              let message = row["message"] as? [String: Any],
              message["role"] as? String == "user",
              let content = message["content"]
        else { return }
        var fragments: [String] = []
        self.collectText(content, into: &fragments)
        inspection.record = SessionRecord(
            threadId: sessionId,
            name: inspection.aiTitle ?? fragments.first.flatMap { self.string($0, maxLength: 500) },
            cwd: self.string(row["cwd"]),
            createdAt: self.timestampMs(row["timestamp"]),
            updatedAt: updatedAt,
            source: "claude-cli",
            gitBranch: self.string(row["gitBranch"], maxLength: 500),
            fileURL: fileURL)
        inspection.shouldStop = true
    }

    private static func sessions(homeURL: URL, projectsURL: URL) throws -> [SessionRecord] {
        try Task.checkCancellation()
        let rootPath = projectsURL.standardizedFileURL.path
        let enumerationObserver = self.catalogEnumerationObserver.value
        enumerationObserver?(rootPath)
        let resolvedProjectsURL = projectsURL.resolvingSymlinksInPath()
        var records: [String: SessionRecord] = [:]
        var sidechainIds = Set<String>()
        var projectFiles: [[URL]] = []
        for projectURL in self.childDirectories(projectsURL) {
            try Task.checkCancellation()
            let files = (try? FileManager.default.contentsOfDirectory(
                at: projectURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles])) ?? []
            projectFiles.append(files)
            guard let indexURL = files.first(where: { $0.lastPathComponent == "sessions-index.json" }),
                  let index = readJSON(indexURL) as? [String: Any],
                  let entries = index["entries"] as? [[String: Any]]
            else { continue }
            for entry in entries {
                try Task.checkCancellation()
                guard let sessionId = string(entry["sessionId"], maxLength: 256) else { continue }
                if (entry["isSidechain"] as? Bool) == true {
                    sidechainIds.insert(sessionId)
                    records.removeValue(forKey: sessionId)
                    continue
                }
                let indexedPath = self.string(entry["fullPath"])
                let candidate = indexedPath.map { URL(filePath: $0) } ??
                    projectURL.appending(path: "\(sessionId).jsonl")
                guard let fileURL = safeSessionFile(
                    root: projectsURL,
                    resolvedRoot: resolvedProjectsURL,
                    candidate: candidate,
                    sessionId: sessionId)
                else { continue }
                records[sessionId] = SessionRecord(
                    threadId: sessionId,
                    name: self.string(entry["summary"], maxLength: 500) ??
                        self.string(entry["firstPrompt"], maxLength: 500),
                    cwd: self.string(entry["projectPath"]),
                    createdAt: self.timestampMs(entry["created"]),
                    updatedAt: self.timestampMs(entry["modified"]) ?? self.timestampMs(entry["fileMtime"]),
                    source: "claude-cli",
                    gitBranch: self.string(entry["gitBranch"], maxLength: 500),
                    fileURL: fileURL)
            }
        }

        try self.discoverCLIRecords(
            projectsURL: projectsURL,
            resolvedProjectsURL: resolvedProjectsURL,
            projectFiles: projectFiles,
            records: &records,
            sidechainIds: &sidechainIds)

        // Reuse this refresh's inventory: stale Desktop metadata must not trigger
        // a filesystem walk for every missing transcript. Candidates still pass path validation.
        let sessionFiles = Dictionary(
            grouping: projectFiles.joined().filter { $0.pathExtension == "jsonl" },
            by: \.lastPathComponent)
        let desktop = try self.desktopMetadata(homeURL: homeURL)
        for sessionId in desktop.archived {
            try Task.checkCancellation()
            records.removeValue(forKey: sessionId)
        }
        for (sessionId, metadata) in desktop.active {
            try Task.checkCancellation()
            if sidechainIds.contains(sessionId) {
                continue
            }
            let record = records[sessionId]
            guard let fileURL = record?.fileURL ??
                (sessionFiles["\(sessionId).jsonl"] ?? []).lazy.compactMap({ candidate in
                    self.safeSessionFile(
                        root: projectsURL,
                        resolvedRoot: resolvedProjectsURL,
                        candidate: candidate,
                        sessionId: sessionId)
                }).first
            else { continue }
            records[sessionId] = SessionRecord(
                threadId: sessionId,
                name: self.string(metadata["title"], maxLength: 500) ?? record?.name,
                cwd: self.string(metadata["cwd"]) ?? self.string(metadata["originCwd"]) ?? record?.cwd,
                createdAt: self.timestampMs(metadata["createdAt"]) ?? record?.createdAt,
                updatedAt: self.timestampMs(metadata["lastActivityAt"]) ?? record?.updatedAt,
                source: "claude-desktop",
                gitBranch: record?.gitBranch,
                fileURL: fileURL)
        }
        return records.values.sorted { left, right in
            let leftTime = left.updatedAt ?? 0
            let rightTime = right.updatedAt ?? 0
            return leftTime == rightTime ? left.threadId < right.threadId : leftTime > rightTime
        }
    }
}

extension MacNodeClaudeSessionCatalog {
    private static func decodeObject(_ paramsJSON: String?) throws -> [String: Any] {
        guard let paramsJSON, !paramsJSON.isEmpty else { return [:] }
        guard let value = try? JSONSerialization.jsonObject(with: Data(paramsJSON.utf8)) as? [String: Any]
        else { throw CatalogError.invalidParams("parameters must be valid JSON objects") }
        return value
    }

    private static func requireOnlyKeys(_ value: [String: Any], allowed: Set<String>) throws {
        if let unknown = value.keys.first(where: { !allowed.contains($0) }) {
            throw CatalogError.invalidParams("unknown Claude session parameter: \(unknown)")
        }
    }

    private static func boundedLimit(_ value: Any?, fallback: Int, max: Int) throws -> Int {
        guard let value else { return fallback }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.rounded() == number.doubleValue,
              number.intValue >= 1,
              number.intValue <= max
        else { throw CatalogError.invalidParams("limit must be an integer from 1 to \(max)") }
        return number.intValue
    }

    private static func decodeListParams(_ paramsJSON: String?) throws -> ListParams {
        let value = try decodeObject(paramsJSON)
        try requireOnlyKeys(value, allowed: ["cursor", "limit", "searchTerm"])
        let cursor = self.string(value["cursor"], maxLength: self.maxCursorLength)
        let search = self.string(value["searchTerm"], maxLength: self.maxSearchLength)
        return try ListParams(
            cursor: cursor,
            limit: self.boundedLimit(value["limit"], fallback: self.defaultPageLimit, max: self.maxPageLimit),
            searchTerm: search)
    }

    private static func decodeReadParams(_ paramsJSON: String?) throws -> ReadParams {
        let value = try decodeObject(paramsJSON)
        try requireOnlyKeys(value, allowed: ["threadId", "cursor", "limit"])
        guard let threadId = string(value["threadId"], maxLength: maxSessionIdLength),
              threadId.range(of: "^[A-Za-z0-9._:-]+$", options: .regularExpression) != nil
        else { throw CatalogError.invalidParams("threadId is invalid") }
        return try ReadParams(
            threadId: threadId,
            cursor: self.string(value["cursor"], maxLength: self.maxCursorLength),
            limit: self.boundedLimit(value["limit"], fallback: self.defaultReadLimit, max: self.maxReadLimit))
    }

    private static func encodeCursor(_ offset: Int) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["offset": offset], options: [.sortedKeys])
        return self.encodeCursorData(data)
    }

    private static func encodeTranscriptCursor(offset: Int, leaseId: String) throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: [
                "lease": leaseId,
                "offset": offset,
            ],
            options: [.sortedKeys])
        return self.encodeCursorData(data)
    }

    private static func encodeCursorData(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decodeTranscriptCursor(_ cursor: String) throws -> TranscriptCursor {
        let value = try self.decodeCursorObject(cursor, label: "transcript")
        guard let offset = value["offset"] as? NSNumber,
              offset.intValue >= 0
        else { throw CatalogError.invalidParams("transcript cursor is invalid") }
        let leaseId = self.string(value["lease"], maxLength: 64)
        if value["lease"] != nil, leaseId == nil {
            throw CatalogError.invalidParams("transcript cursor is invalid")
        }
        return TranscriptCursor(offset: offset.intValue, leaseId: leaseId)
    }

    private static func decodeCursor(_ cursor: String?, label: String) throws -> Int {
        guard let cursor else { return 0 }
        let value = try self.decodeCursorObject(cursor, label: label)
        guard let offset = value["offset"] as? NSNumber,
              offset.intValue >= 0
        else { throw CatalogError.invalidParams("\(label) cursor is invalid") }
        return offset.intValue
    }

    private static func decodeCursorObject(_ cursor: String, label: String) throws -> [String: Any] {
        guard cursor.count <= self.maxCursorLength else {
            throw CatalogError.invalidParams("\(label) cursor is invalid")
        }
        var base64 = cursor.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw CatalogError.invalidParams("\(label) cursor is invalid") }
        return value
    }

    private static func encode(_ value: [String: Any], maxBytes: Int? = nil) throws -> String {
        guard JSONSerialization.isValidJSONObject(value) else { throw CatalogError.unavailable }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        if let maxBytes, data.count > maxBytes {
            throw CatalogError.responseTooLarge
        }
        return String(bytes: data, encoding: .utf8)!
    }

    private static func truncateUTF8(_ value: String, maxBytes: Int) -> String {
        guard value.utf8.count > maxBytes else { return value }
        var data = Data(value.utf8.prefix(maxBytes))
        while !data.isEmpty {
            if let result = String(data: data, encoding: .utf8) {
                return result
            }
            data.removeLast()
        }
        return ""
    }
}

extension MacNodeClaudeSessionCatalog {
    private static func collectText(_ value: Any, into fragments: inout [String]) {
        if let value = value as? String {
            if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                fragments.append(value)
            }
            return
        }
        if let values = value as? [Any] {
            for value in values {
                self.collectText(value, into: &fragments)
            }
            return
        }
        guard let value = value as? [String: Any] else { return }
        for key in ["text", "thinking", "content", "input"] {
            if let child = value[key] {
                self.collectText(child, into: &fragments)
            }
        }
    }

    private static func itemType(role: String, content: Any) -> String {
        guard let blocks = content as? [[String: Any]] else {
            return role == "user" ? "userMessage" : "agentMessage"
        }
        let types = blocks.compactMap { $0["type"] as? String }
        if !types.isEmpty, types.allSatisfy({ $0 == "tool_result" }) {
            return "toolResult"
        }
        if !types.isEmpty, types.allSatisfy({ $0 == "tool_use" }) {
            return "toolCall"
        }
        if !types.isEmpty, types.allSatisfy({ $0 == "thinking" }) {
            return "reasoning"
        }
        return role == "user" ? "userMessage" : "agentMessage"
    }

    private static func parseTranscriptLine(_ data: Data) -> [String: Any]? {
        guard let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (row["isSidechain"] as? Bool) != true,
              let type = row["type"] as? String,
              type == "user" || type == "assistant",
              let message = row["message"] as? [String: Any],
              let role = message["role"] as? String,
              role == type,
              let content = message["content"],
              content is String || content is [Any]
        else { return nil }
        var fragments: [String] = []
        self.collectText(content, into: &fragments)
        let text = Array(NSOrderedSet(array: fragments)) as? [String] ?? fragments
        var item: [String: Any] = [
            "type": itemType(role: role, content: content),
            "content": content,
        ]
        if !text.isEmpty {
            item["text"] = text.joined(separator: "\n\n")
        }
        if let timestamp = string(row["timestamp"], maxLength: 128) {
            item["timestamp"] = timestamp
        }
        if let model = string(message["model"], maxLength: 256) {
            item["model"] = model
        }
        if let uuid = string(row["uuid"], maxLength: 256) {
            item["uuid"] = uuid
        }
        if let encoded = try? JSONSerialization.data(withJSONObject: item),
           encoded.count <= self.maxTranscriptItemBytes
        {
            return item
        }
        let fullText = (item["text"] as? String) ?? ""
        let truncated = self.truncateUTF8(fullText, maxBytes: self.maxTruncatedTranscriptTextBytes) +
            "\n\n[oversized Claude item truncated]"
        let fallback: [String: Any] = [
            "type": item["type"] ?? "item",
            "text": truncated,
            "truncated": true,
        ]
        guard let encoded = try? JSONSerialization.data(withJSONObject: fallback),
              encoded.count <= maxTranscriptItemBytes
        else {
            return ["type": item["type"] ?? "item", "truncated": true]
        }
        return fallback
    }
}
