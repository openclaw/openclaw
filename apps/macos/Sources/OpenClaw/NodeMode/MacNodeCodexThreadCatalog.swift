import CoreFoundation
import CryptoKit
import Darwin
import Foundation

enum MacNodeCodexThreadCatalog {
    struct ResolvedInvocation: Equatable, Sendable {
        var executable: String
        var arguments: [String]
        var cwd: URL?
        var clearEnv: [String] = []
    }

    enum CatalogError: LocalizedError, Equatable {
        case invalidParams(String)
        case catalogDisabled
        case invalidAppServerConfiguration
        case codexUnavailable
        case unsupportedAppServerTransport
        case unsupportedAppServerHomeScope
        case appServerUnavailable
        case responseTooLarge
        case timedOut

        var errorDescription: String? {
            switch self {
            case let .invalidParams(message):
                "INVALID_REQUEST: \(message)"
            case .catalogDisabled:
                "UNAVAILABLE: Codex session catalog is disabled"
            case .invalidAppServerConfiguration:
                "UNAVAILABLE: Codex app-server configuration is invalid"
            case .codexUnavailable:
                "UNAVAILABLE: Codex CLI not found"
            case .unsupportedAppServerTransport:
                "UNAVAILABLE: paired macOS Codex catalog supports appServer.transport stdio only"
            case .unsupportedAppServerHomeScope:
                "UNAVAILABLE: paired macOS Codex catalog requires appServer.homeScope user"
            case .appServerUnavailable:
                "UNAVAILABLE: Codex app-server request failed"
            case .responseTooLarge:
                "UNAVAILABLE: Codex app-server response exceeded the size limit"
            case .timedOut:
                "UNAVAILABLE: Codex app-server request timed out"
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
        var sourceHomeId: String?
        var cursor: String?
        var limit = 50
        var searchTerm: String?
        var cwd: String?
    }

    private struct TurnParams {
        var sourceHomeId: String?
        var threadId: String
        var cursor: String?
        var limit = 20
    }

    private struct ConfiguredAppServer {
        var transport: String?
        var homeScope: String?
        var command: String?
        var args: [String]?
        var clearEnv: [String]
    }

    private struct ConfiguredPlugin {
        var sessionCatalogEnabled: Bool
        var appServer: ConfiguredAppServer?
    }

    private enum StringOverflow {
        case omit
        case truncate
    }

    private static let defaultArguments = ["app-server", "--listen", "stdio://"]
    private static let commandEnvironmentKey = "OPENCLAW_CODEX_APP_SERVER_BIN"
    private static let argumentsEnvironmentKey = "OPENCLAW_CODEX_APP_SERVER_ARGS"
    static let defaultMacOSChatGPTAppExecutable =
        "/Applications/ChatGPT.app/Contents/Resources/codex"
    static let defaultUserMacOSChatGPTAppExecutable = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/ChatGPT.app/Contents/Resources/codex")
        .path
    static let defaultMacOSAppExecutable = "/Applications/Codex.app/Contents/Resources/codex"
    static let defaultUserMacOSAppExecutable = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Codex.app/Contents/Resources/codex")
        .path
    static let defaultMacOSBetaAppExecutable = "/Applications/Codex Beta.app/Contents/Resources/codex"
    static let defaultUserMacOSBetaAppExecutable = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Applications/Codex Beta.app/Contents/Resources/codex")
        .path
    static let defaultTimeoutSeconds: Double = 60
    static let defaultIdleTimeoutSeconds: Double = 30
    private static let maxSessionIdLength = 256
    private static let maxSessionNameLength = 500
    private static let maxCwdLength = 4096
    private static let maxStatusLength = 64
    private static let maxMetadataLength = 500
    private static let maxActiveFlags = 16
    private static let maxActiveFlagLength = 128
    private static let maxCursorLength = 4096
    private static let maxSearchPageCalls = 4

    private struct WireResponse: Encodable {
        let canContinueCodex = true
        let sourceHomeId: String
        var sessions: [WireSession]
        var nextCursor: String?
        var backwardsCursor: String?
    }

    private struct WireSession: Encodable {
        var threadId: String
        var sessionId: String?
        var name: String?
        var cwd: String?
        var status: String
        var activeFlags: [String]?
        var createdAt: Int64?
        var updatedAt: Int64?
        var recencyAt: Int64?
        var source: String?
        var modelProvider: String?
        var cliVersion: String?
        var gitBranch: String?
        var archived: Bool
    }

    static func list(
        paramsJSON: String?,
        loadRoot: () -> [String: Any],
        client: CodexAppServerThreadClient) async throws -> String
    {
        let params = try self.decodeParams(paramsJSON)
        // Keep authorization and spawn selection on one config snapshot. A second read could
        // otherwise approve one command and launch another after a concurrent config rewrite.
        let root = loadRoot()
        guard self.shouldAdvertise(root: root) else {
            throw CatalogError.catalogDisabled
        }
        let invocation = try self.resolveInvocation(root: root)
        return try await self.encodeResponse(self.list(params: params, invocation: invocation, client: client))
    }

    static func turns(
        paramsJSON: String?,
        loadRoot: () -> [String: Any],
        client: CodexAppServerThreadClient) async throws -> String
    {
        let params = try decodeTurnParams(paramsJSON)
        let root = loadRoot()
        guard self.shouldAdvertise(root: root) else {
            throw CatalogError.catalogDisabled
        }
        return try await self.turns(
            params: params,
            invocation: resolveInvocation(root: root),
            client: client)
    }

    private static func turns(
        params: TurnParams,
        invocation: ResolvedInvocation,
        client: CodexAppServerThreadClient,
        timeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultTimeoutSeconds,
        maxLineBytes: Int = 20 * 1024 * 1024) async throws -> String
    {
        let deadline = Date().addingTimeInterval(max(0.01, timeoutSeconds))
        let sourceHomeId = try await self.requireCatalogThread(
            params.threadId,
            sourceHomeId: params.sourceHomeId,
            invocation: invocation,
            client: client,
            deadline: deadline)
        var requestParams: [String: Any] = [
            "threadId": params.threadId,
            "limit": params.limit,
            "sortDirection": "desc",
            "itemsView": "full",
        ]
        if let cursor = params.cursor {
            requestParams["cursor"] = cursor
        }
        let response = try await client.request(
            invocation: invocation,
            method: "thread/turns/list",
            requestParams: requestParams,
            sourceHomeId: sourceHomeId,
            timeoutSeconds: max(0.01, deadline.timeIntervalSinceNow),
            maxLineBytes: maxLineBytes)
        guard let payload = String(data: response.data, encoding: .utf8) else {
            throw CatalogError.appServerUnavailable
        }
        return payload
    }

    private static func requireCatalogThread(
        _ threadId: String,
        sourceHomeId: String?,
        invocation: ResolvedInvocation,
        client: CodexAppServerThreadClient,
        deadline: Date) async throws -> String
    {
        var sourceHomeId = sourceHomeId
        var cursor: String?
        var seenCursors = Set<String>()
        for _ in 0..<100 {
            let remainingTimeout = deadline.timeIntervalSinceNow
            guard remainingTimeout > 0 else { throw CatalogError.timedOut }
            let response = try await list(
                params: ListParams(sourceHomeId: sourceHomeId, cursor: cursor, limit: 100),
                invocation: invocation,
                client: client,
                timeoutSeconds: remainingTimeout)
            sourceHomeId = response.sourceHomeId
            if response.sessions.contains(where: { $0.threadId == threadId }) {
                return response.sourceHomeId
            }
            guard let nextCursor = response.nextCursor,
                  !seenCursors.contains(nextCursor)
            else { break }
            seenCursors.insert(nextCursor)
            cursor = nextCursor
        }
        throw CatalogError.invalidParams(
            "Codex session is not a non-archived interactive CLI or VS Code session")
    }

    static func shouldAdvertise(root: [String: Any]? = nil) -> Bool {
        let root = root ?? OpenClawConfigFile.loadDict()
        guard OpenClawConfigFile.configuredBundledPluginAllowed(
            MacNodeCodexThreadCatalogContract.pluginId,
            root: root)
        else { return false }
        let plugin: ConfiguredPlugin?
        do {
            plugin = try self.configuredPlugin(root: root)
        } catch {
            return false
        }
        guard plugin?.sessionCatalogEnabled == true else { return false }
        return self.supportsConfiguredTransport(plugin?.appServer) &&
            self.supportsConfiguredHomeScope(plugin?.appServer)
    }

    private static func list(
        params: ListParams,
        invocation: ResolvedInvocation,
        client: CodexAppServerThreadClient,
        timeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultTimeoutSeconds,
        maxLineBytes: Int = 5 * 1024 * 1024) async throws -> WireResponse
    {
        guard params.searchTerm != nil else {
            let response = try await client.request(
                invocation: invocation,
                method: "thread/list",
                requestParams: self.appServerParams(params),
                sourceHomeId: params.sourceHomeId,
                timeoutSeconds: timeoutSeconds,
                maxLineBytes: maxLineBytes)
            return try self.normalizedResponse(
                listResultData: response.data,
                sourceHomeId: response.sourceHomeId)
        }

        // Native search also inspects transcript-derived previews. Scan a bounded
        // number of unsearched pages and filter normalized titles locally instead.
        let deadline = Date().addingTimeInterval(max(0.01, timeoutSeconds))
        var sessions: [WireSession] = []
        var sourceHomeId = params.sourceHomeId
        var cursor = params.cursor
        var seenCursors = Set(cursor.map { [$0] } ?? [])
        var backwardsCursor: String?
        var nextCursor: String?

        for pageIndex in 0..<self.maxSearchPageCalls {
            let remainingLimit = params.limit - sessions.count
            guard remainingLimit > 0 else { break }
            let remainingTimeout = deadline.timeIntervalSinceNow
            guard remainingTimeout > 0 else { throw CatalogError.timedOut }

            var pageParams = params
            pageParams.cursor = cursor
            pageParams.limit = remainingLimit
            let response = try await client.request(
                invocation: invocation,
                method: "thread/list",
                requestParams: self.appServerParams(pageParams),
                sourceHomeId: sourceHomeId,
                timeoutSeconds: remainingTimeout,
                maxLineBytes: maxLineBytes)
            sourceHomeId = response.sourceHomeId
            let page = try self.normalizedResponse(
                listResultData: response.data,
                sourceHomeId: response.sourceHomeId,
                searchTerm: params.searchTerm)
            if pageIndex == 0 {
                backwardsCursor = page.backwardsCursor
            }
            sessions.append(contentsOf: page.sessions)

            guard let candidateCursor = page.nextCursor else {
                nextCursor = nil
                break
            }
            guard !seenCursors.contains(candidateCursor) else {
                // A repeated opaque cursor cannot make forward progress. Stop the
                // page chain instead of handing callers a permanent load-more loop.
                nextCursor = nil
                break
            }
            nextCursor = candidateCursor
            if sessions.count >= params.limit || pageIndex + 1 == self.maxSearchPageCalls {
                break
            }
            seenCursors.insert(candidateCursor)
            cursor = candidateCursor
        }

        guard let sourceHomeId else { throw CatalogError.appServerUnavailable }
        return WireResponse(
            sourceHomeId: sourceHomeId,
            sessions: sessions,
            nextCursor: nextCursor,
            backwardsCursor: backwardsCursor)
    }
}

extension MacNodeCodexThreadCatalog {
    static func resolveInvocation(
        root: [String: Any]? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        searchPaths: [String]? = nil,
        currentDirectoryURL: URL = URL(
            fileURLWithPath: FileManager.default.currentDirectoryPath,
            isDirectory: true),
        defaultMacOSChatGPTAppExecutable: String = MacNodeCodexThreadCatalog
            .defaultMacOSChatGPTAppExecutable,
        defaultUserMacOSChatGPTAppExecutable: String = MacNodeCodexThreadCatalog
            .defaultUserMacOSChatGPTAppExecutable,
        defaultMacOSAppExecutable: String = MacNodeCodexThreadCatalog.defaultMacOSAppExecutable,
        defaultUserMacOSAppExecutable: String = MacNodeCodexThreadCatalog.defaultUserMacOSAppExecutable,
        defaultMacOSBetaAppExecutable: String = MacNodeCodexThreadCatalog.defaultMacOSBetaAppExecutable,
        defaultUserMacOSBetaAppExecutable: String = MacNodeCodexThreadCatalog.defaultUserMacOSBetaAppExecutable) throws
        -> ResolvedInvocation
    {
        let root = root ?? OpenClawConfigFile.loadDict()
        let appServer = try self.configuredPlugin(root: root)?.appServer
        guard self.supportsConfiguredTransport(appServer) else {
            throw CatalogError.unsupportedAppServerTransport
        }
        guard self.supportsConfiguredHomeScope(appServer) else {
            throw CatalogError.unsupportedAppServerHomeScope
        }
        let environmentCommand = self.nonEmptyString(environment[self.commandEnvironmentKey])
        let customCommand = appServer?.command ?? environmentCommand
        let command = customCommand ?? "codex"

        let executable: String?
        var installedAppExecutable: String?
        if customCommand == nil {
            installedAppExecutable = [
                defaultMacOSChatGPTAppExecutable,
                defaultUserMacOSChatGPTAppExecutable,
                defaultMacOSAppExecutable,
                defaultUserMacOSAppExecutable,
                defaultMacOSBetaAppExecutable,
                defaultUserMacOSBetaAppExecutable,
            ]
                .first { FileManager.default.isExecutableFile(atPath: $0) }
        }
        if let installedAppExecutable {
            executable = installedAppExecutable
        } else if command.contains("/") || command.hasPrefix("~") {
            let url = self.resolvePath(command, relativeTo: currentDirectoryURL)
            executable = FileManager.default.isExecutableFile(atPath: url.path) ? url.path : nil
        } else {
            executable = CommandResolver.findExecutable(named: command, searchPaths: searchPaths)
        }
        guard let executable else { throw CatalogError.codexUnavailable }
        let configuredArguments = appServer?.args ?? environment[self.argumentsEnvironmentKey].map {
            self.splitShellWords($0)
        }
        let arguments = if let configuredArguments, !configuredArguments.isEmpty {
            configuredArguments
        } else {
            self.defaultArguments
        }
        return ResolvedInvocation(
            executable: executable,
            arguments: arguments,
            cwd: nil,
            clearEnv: appServer?.clearEnv ?? [])
    }

    private static func supportsConfiguredTransport(_ appServer: ConfiguredAppServer?) -> Bool {
        appServer?.transport == nil || appServer?.transport == "stdio"
    }

    private static func supportsConfiguredHomeScope(_ appServer: ConfiguredAppServer?) -> Bool {
        appServer?.homeScope == nil || appServer?.homeScope == "user"
    }

    private static func configuredPlugin(root: [String: Any]) throws -> ConfiguredPlugin? {
        guard let entry = OpenClawConfigFile.pluginEntry(
            MacNodeCodexThreadCatalogContract.pluginId,
            root: root)
        else { return nil }
        guard let rawConfig = entry["config"] else {
            return ConfiguredPlugin(sessionCatalogEnabled: true, appServer: nil)
        }
        guard let config = rawConfig as? [String: Any] else {
            throw CatalogError.invalidAppServerConfiguration
        }
        // The plugin owns its schema. Validate only the fields this native reader consumes,
        // so unrelated plugin options cannot disable the catalog as that schema evolves.
        let sessionCatalog = try self.configuredValue(config["sessionCatalog"], as: [String: Any].self)
        let enabled: Bool
        if let value = sessionCatalog?["enabled"] {
            guard let flag = self.literalBoolean(value) else { throw CatalogError.invalidAppServerConfiguration }
            enabled = flag
        } else {
            enabled = true
        }
        let appServer = try self.configuredValue(config["appServer"], as: [String: Any].self).map { value in
            let transport = try self.configuredValue(value["transport"], as: String.self)
            let homeScope = try self.configuredValue(value["homeScope"], as: String.self)
            guard transport.map({ ["stdio", "websocket", "unix"].contains($0) }) ?? true,
                  homeScope.map({ ["agent", "user"].contains($0) }) ?? true
            else { throw CatalogError.invalidAppServerConfiguration }
            return try ConfiguredAppServer(
                transport: transport,
                homeScope: homeScope,
                command: self.configuredValue(value["command"], as: String.self)?.nonEmpty,
                args: self.configuredArguments(value["args"]),
                clearEnv: (self.configuredValue(value["clearEnv"], as: [String].self) ?? [])
                    .compactMap(self.nonEmptyString))
        }
        return ConfiguredPlugin(sessionCatalogEnabled: enabled, appServer: appServer)
    }

    private static func configuredValue<Value>(_ value: Any?, as _: Value.Type) throws -> Value? {
        guard let value else { return nil }
        guard let typed = value as? Value else { throw CatalogError.invalidAppServerConfiguration }
        return typed
    }

    private static func configuredArguments(_ value: Any?) throws -> [String]? {
        guard let value else { return nil }
        if let values = value as? [String] {
            return values.compactMap(self.nonEmptyString)
        } else if let value = value as? String {
            return self.splitShellWords(value)
        } else {
            throw CatalogError.invalidAppServerConfiguration
        }
    }

    private static func literalBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else { return nil }
        return number.boolValue
    }

    /// Match the TypeScript app-server config parser exactly: quotes only group
    /// words and backslashes are ordinary characters. The result never uses a shell.
    private static func splitShellWords(_ value: String) -> [String] {
        var words: [String] = []
        var current = ""
        var activeQuote: Character?
        for character in value {
            if let expectedQuote = activeQuote {
                if character == expectedQuote {
                    activeQuote = nil
                } else {
                    current.append(character)
                }
                continue
            }
            if character == "\"" || character == "'" {
                activeQuote = character
            } else if character.isWhitespace {
                if !current.isEmpty {
                    words.append(current)
                    current = ""
                }
            } else {
                current.append(character)
            }
        }
        if !current.isEmpty {
            words.append(current)
        }
        return words
    }

    private static func resolvePath(
        _ path: String,
        relativeTo base: URL,
        isDirectory: Bool = false) -> URL
    {
        let expanded = (path as NSString).expandingTildeInPath
        if expanded.hasPrefix("/") {
            return URL(fileURLWithPath: expanded, isDirectory: isDirectory).standardizedFileURL
        }
        return URL(fileURLWithPath: expanded, isDirectory: isDirectory, relativeTo: base)
            .standardizedFileURL
    }

    private static func decodeRequestObject(_ paramsJSON: String?) throws -> [String: Any] {
        guard let paramsJSON, !paramsJSON.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return [:]
        }
        guard let data = paramsJSON.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw CatalogError.invalidParams("parameters must be a valid JSON object")
        }
        // Native discovery stays in the node user's Codex home. The Gateway's
        // route owner is context, never an agent-home selector or native RPC field.
        _ = try self.optionalString(raw, key: "agentId", maxLength: self.maxSessionIdLength)
        return raw
    }

    private static func decodeParams(_ paramsJSON: String?) throws -> ListParams {
        let raw = try self.decodeRequestObject(paramsJSON)
        let allowed = Set(["agentId", "sourceHomeId", "cursor", "limit", "searchTerm", "cwd"])
        if let unknown = raw.keys.first(where: { !allowed.contains($0) }) {
            throw CatalogError.invalidParams("unknown Codex session catalog parameter: \(unknown)")
        }

        var params = ListParams()
        params.sourceHomeId = try self.optionalString(raw, key: "sourceHomeId", maxLength: 64)
        params.cursor = try self.optionalString(raw, key: "cursor", maxLength: self.maxCursorLength)
        params.searchTerm = try self.optionalString(
            raw,
            key: "searchTerm",
            maxLength: self.maxSessionNameLength)
        params.cwd = try self.optionalString(raw, key: "cwd", maxLength: self.maxCwdLength)
        params.limit = try self.decodeLimit(raw["limit"], fallback: params.limit, maximum: 100)
        return params
    }

    private static func decodeTurnParams(_ paramsJSON: String?) throws -> TurnParams {
        let raw = try self.decodeRequestObject(paramsJSON)
        let allowed = Set(["agentId", "sourceHomeId", "threadId", "cursor", "limit"])
        if let unknown = raw.keys.first(where: { !allowed.contains($0) }) {
            throw CatalogError.invalidParams("unknown Codex transcript parameter: \(unknown)")
        }
        guard let threadId = try optionalString(
            raw,
            key: "threadId",
            maxLength: maxSessionIdLength)
        else {
            throw CatalogError.invalidParams("threadId is required")
        }
        var params = TurnParams(threadId: threadId)
        params.sourceHomeId = try self.optionalString(raw, key: "sourceHomeId", maxLength: 64)
        params.cursor = try self.optionalString(raw, key: "cursor", maxLength: self.maxCursorLength)
        params.limit = try self.decodeLimit(raw["limit"], fallback: params.limit, maximum: 50)
        return params
    }

    private static func decodeLimit(_ value: Any?, fallback: Int, maximum: Int) throws -> Int {
        guard let value else { return fallback }
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.rounded() == number.doubleValue,
              (1...maximum).contains(number.intValue)
        else {
            throw CatalogError.invalidParams("limit must be an integer from 1 to \(maximum)")
        }
        return number.intValue
    }

    private static func optionalString(
        _ params: [String: Any],
        key: String,
        maxLength: Int) throws -> String?
    {
        guard let value = params[key] else { return nil }
        guard let value = value as? String else {
            throw CatalogError.invalidParams("\(key) must be a string")
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.utf16.count <= maxLength else {
            throw CatalogError.invalidParams("\(key) must be at most \(maxLength) characters")
        }
        return trimmed
    }

    private static func appServerParams(_ params: ListParams) -> [String: Any] {
        var result: [String: Any] = [
            "limit": params.limit,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            // An empty provider list means all providers. Omitting sourceKinds keeps
            // Codex's stable interactive-session default.
            "modelProviders": [String](),
            "archived": false,
            "useStateDbOnly": false,
        ]
        if let cursor = params.cursor {
            result["cursor"] = cursor
        }
        // Search only the normalized names below. App Server title search can
        // match transcript-derived previews that the node boundary withholds.
        if let cwd = params.cwd {
            result["cwd"] = cwd
        }
        return result
    }

    static func sourceHomeId(codexHome: String) throws -> String {
        guard codexHome.hasPrefix("/"), !codexHome.utf8.contains(0) else {
            throw CatalogError.appServerUnavailable
        }
        var components: [Substring] = []
        for component in codexHome.split(separator: "/") {
            switch component {
            case ".": continue
            case "..":
                if !components.isEmpty { components.removeLast() }
            default: components.append(component)
            }
        }
        let absolute = "/" + components.joined(separator: "/")
        let canonical: String
        if let resolved = realpath(absolute, nil) {
            defer { free(resolved) }
            canonical = String(cString: resolved)
        } else {
            canonical = absolute
        }
        // Match the Node catalog identity without exposing the native home path.
        return SHA256.hash(data: Data(("openclaw:codex-session-catalog-home:v1\u{0}" + canonical).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }

    static func normalize(
        listResultData: Data,
        sourceHomeId: String,
        searchTerm: String? = nil) throws -> String
    {
        try self.encodeResponse(self.normalizedResponse(
            listResultData: listResultData,
            sourceHomeId: sourceHomeId,
            searchTerm: searchTerm))
    }

    private static func normalizedResponse(
        listResultData: Data,
        sourceHomeId: String,
        searchTerm: String? = nil) throws -> WireResponse
    {
        guard let result = try JSONSerialization.jsonObject(with: listResultData) as? [String: Any],
              let rawThreads = result["data"] as? [Any]
        else {
            throw CatalogError.appServerUnavailable
        }

        let sessions = rawThreads.compactMap { value -> WireSession? in
            guard let thread = value as? [String: Any],
                  let threadId = self.boundedString(
                      thread["id"],
                      maxLength: self.maxSessionIdLength)
            else { return nil }
            let statusRecord = thread["status"] as? [String: Any]
            let status = self.boundedString(
                statusRecord?["type"],
                maxLength: self.maxStatusLength) ?? "notLoaded"
            let decodedActiveFlags = (statusRecord?["activeFlags"] as? [Any])?
                .compactMap {
                    self.boundedString($0, maxLength: self.maxActiveFlagLength)
                }
                .prefix(self.maxActiveFlags)
            let activeFlags = decodedActiveFlags?.isEmpty == false ? decodedActiveFlags : nil
            let gitInfo = thread["gitInfo"] as? [String: Any]
            let name = self.boundedString(
                thread["name"],
                maxLength: self.maxSessionNameLength,
                overflow: .truncate)
            if let searchTerm,
               name?.range(of: searchTerm, options: [.caseInsensitive, .literal]) == nil
            {
                return nil
            }
            return WireSession(
                threadId: threadId,
                sessionId: self.boundedString(
                    thread["sessionId"],
                    maxLength: self.maxSessionIdLength),
                name: name,
                cwd: self.boundedString(thread["cwd"], maxLength: self.maxCwdLength),
                status: status,
                activeFlags: activeFlags.map(Array.init),
                createdAt: self.integer(thread["createdAt"]),
                updatedAt: self.integer(thread["updatedAt"]),
                recencyAt: self.integer(thread["recencyAt"]),
                source: self.sourceName(thread["source"]),
                modelProvider: self.boundedString(
                    thread["modelProvider"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                cliVersion: self.boundedString(
                    thread["cliVersion"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                gitBranch: self.boundedString(
                    gitInfo?["branch"],
                    maxLength: self.maxMetadataLength,
                    overflow: .truncate),
                archived: false)
        }

        return WireResponse(
            sourceHomeId: sourceHomeId,
            sessions: sessions,
            nextCursor: self.boundedCursor(result["nextCursor"]),
            backwardsCursor: self.boundedCursor(result["backwardsCursor"]))
    }

    private static func encodeResponse(_ response: WireResponse) throws -> String {
        try String(bytes: JSONEncoder().encode(response), encoding: .utf8)!
    }

    fileprivate static func nonEmptyString(_ value: Any?) -> String? {
        (value as? String)?.nonEmpty
    }

    private static func boundedString(
        _ value: Any?,
        maxLength: Int,
        overflow: StringOverflow = .omit) -> String?
    {
        guard let value = self.nonEmptyString(value) else { return nil }
        guard value.utf16.count > maxLength else { return value }
        guard case .truncate = overflow else { return nil }
        return self.truncateUTF16(value, maxLength: maxLength)
    }

    private static func boundedCursor(_ value: Any?) -> String? {
        guard let value = value as? String,
              self.nonEmptyString(value) != nil,
              value.utf16.count <= self.maxCursorLength
        else { return nil }
        // App Server cursors are opaque; do not trim or regenerate them after
        // locally filtering a page by its normalized session names.
        return value
    }

    private static func truncateUTF16(_ value: String, maxLength: Int) -> String {
        var result = ""
        var length = 0
        for scalar in value.unicodeScalars {
            let scalarLength = scalar.value > 0xFFFF ? 2 : 1
            guard length + scalarLength <= maxLength else { break }
            result.unicodeScalars.append(scalar)
            length += scalarLength
        }
        return result
    }

    private static func integer(_ value: Any?) -> Int64? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        return number.int64Value
    }

    private static func sourceName(_ value: Any?) -> String? {
        let raw: String? = if let source = self.nonEmptyString(value) {
            source
        } else if let source = value as? [String: Any],
                  let custom = self.nonEmptyString(source["custom"])
        {
            "custom:\(custom)"
        } else if let source = value as? [String: Any] {
            source.keys.min()
        } else {
            nil
        }
        return self.boundedString(
            raw,
            maxLength: self.maxMetadataLength,
            overflow: .truncate)
    }
}
