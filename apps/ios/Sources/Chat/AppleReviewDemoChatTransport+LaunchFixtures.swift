import Foundation
import OpenClawChatUI
import OpenClawProtocol

enum ScreenshotFixtureMode {
    /// A process-local fixture store, never backed by an installed user's chat databases.
    static let queueMenuOutbox: OpenClawChatSQLiteTranscriptCache? = {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-queue-menu-fixture") else { return nil }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        return try? OpenClawClientDatabases(directoryURL: directory).store(gatewayID: Self.gatewayID)
    }()

    static var progressBarEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-progress-bar-fixture")
    }

    static var composerModelLayout: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-composer-model-layout-fixture")
    }

    static let gatewayName = "OpenClaw Gateway"
    static let gatewayAddress = "Gateway on local network"
    static let gatewayID = "screenshot-fixture-gateway"
    static var reactionsEnabled: Bool {
        !ProcessInfo.processInfo.arguments.contains("--openclaw-no-reactions-fixture")
    }

    static var progressCardEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-progress-card-fixture")
    }

    /// Two long chats, so switching between them proves where the reader lands.
    static var chatSwitchEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-chat-switch-fixture")
    }

    /// Holds the model catalog, the last step of a chat's load, like a slow Gateway.
    static var slowModelCatalogEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-slow-model-catalog-fixture")
    }

    static let chatSwitchSecondSessionKey = "agent:main:launch-plan"

    /// Holds each send's reply this many milliseconds, like a model that takes a while to start.
    static var replyDelay: Duration? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--openclaw-reply-delay-ms"),
              arguments.indices.contains(index + 1),
              let milliseconds = Int(arguments[index + 1])
        else { return nil }
        return .milliseconds(milliseconds)
    }

    /// One unanswered turn whose tool calls failed, recorded the way tool search records them.
    static var toolFailuresEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-tool-failures-fixture")
    }

    /// Two finished turns of the same work: one answered by Claude (no phase), one by an OpenAI model.
    static var turnPresentationEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-turn-presentation-fixture")
    }

    static let toolFailureChats = [
        (key: "agent:main:subagent:fixture-toasts", label: "Toasts board"),
        (key: "agent:main:subagent:fixture-composer", label: "Composer fixes"),
    ]
}

/// Launch-argument fixtures for screenshot and UI-test runs: model sign-in and session groups.
extension ScreenshotFixtureMode {
    static var modelSignInScenario: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--openclaw-model-sign-in-fixture"),
              arguments.indices.contains(index + 1)
        else { return nil }
        return arguments[index + 1]
    }

    /// How long the sign-in fixture's server takes to answer a step; long enough to read a busy row when set.
    static var modelSignInAnswerMilliseconds: Int {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--openclaw-model-sign-in-answer-ms"),
              arguments.indices.contains(index + 1)
        else { return 500 }
        return Int(arguments[index + 1]) ?? 500
    }

    /// How long the sign-in fixture's server takes to hear back from a browser or a device code.
    static var modelSignInWaitSeconds: Int {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--openclaw-model-sign-in-wait"),
              arguments.indices.contains(index + 1)
        else { return 4 }
        return Int(arguments[index + 1]) ?? 4
    }
}

extension ScreenshotFixtureMode {
    static var holdsInitialChatRun: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-hold-initial-chat-run")
    }
}

/// This fixture uses only local, launch-argument-selected data; no operator Gateway requests.
extension ScreenshotFixtureMode {
    static var groupControlsEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-group-controls-fixture")
    }
}

enum DrawerGroupFixture {
    static let store = DrawerGroupFixtureStore()

    @MainActor
    static func connection() -> OpenClawSessionMenuConnection {
        var connection = OpenClawSessionMenuConnection(
            methods: [
                "sessions.groups.list",
                "sessions.groups.put",
                "sessions.groups.rename",
                "sessions.groups.delete",
                "sessions.groups.defaults",
                "sessions.groups.update",
                "sessions.create",
            ],
            scopes: ["operator.admin"],
            isCurrent: { ScreenshotFixtureMode.groupControlsEnabled },
            request: { try await self.store.request($0) })
        connection.groupDefaultsBrowser = OpenClawGroupDefaultsBrowser(
            listDirectory: { _ in FsListDirResult(path: "/work", home: "/work", entries: []) },
            inspectRepository: { _ in .git })
        return connection
    }
}

actor DrawerGroupFixtureStore {
    private var names = ["Projects", "Research"]
    private var rows = [
        OpenClawChatSessionEntry(
            key: "agent:main:dashboard:fixture-project", displayName: "Project notes", category: "Projects"),
        OpenClawChatSessionEntry(
            key: "agent:main:dashboard:fixture-research", displayName: "Research notes", category: "Research"),
    ]
    private var cwd = "/work/repo"
    private var worktree = true
    private var catalogReads = 0
    private var readsAtDefaults = 0

    func sessions() -> [OpenClawChatSessionEntry] {
        self.rows
    }

    func request(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        let name = request.params["name"]?.value as? String ?? ""
        switch request.method {
        case "sessions.groups.list": self.catalogReads += 1
        case "sessions.groups.put":
            if ProcessInfo.processInfo.arguments.contains("--openclaw-failed-group-change-fixture") {
                throw NSError(domain: "DrawerGroupFixture", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Fixture group mutation rejected",
                ])
            }
            // Keep this local mutation pending long enough to inspect the header's progress indicator.
            try await Task.sleep(for: .seconds(5))
            guard self.catalogReads > self.readsAtDefaults else { throw URLError(.badServerResponse) }
            // AnyCodable retains array elements as AnyCodable after decoding, and native arrays when constructed.
            let raw = request.params["names"]?.value
            self.names = raw as? [String] ?? (raw as? [AnyCodable] ?? []).compactMap { $0.value as? String }
        case "sessions.groups.rename":
            let next = request.params["to"]?.value as? String ?? ""
            self.names = self.names.map { $0 == name ? next : $0 }
            for index in self.rows.indices where self.rows[index].category == name {
                self.rows[index].category = next
            }
        case "sessions.groups.delete":
            self.names.removeAll { $0 == name }
            for index in self.rows.indices where self.rows[index].category == name {
                self.rows[index].category = nil
            }
        case "sessions.groups.defaults":
            self.readsAtDefaults = self.catalogReads
            return try JSONSerialization.data(withJSONObject: ["defaults": self.names.map {
                ["name": $0, "cwd": self.cwd, "worktree": self.worktree] as [String: Any]
            }])
        case "sessions.groups.update":
            self.cwd = request.params["cwd"]?.value as? String ?? ""
            self.worktree = request.params["worktree"]?.value as? Bool ?? false
            return Data(#"{"ok":true}"#.utf8)
        case "sessions.create":
            guard request.params["cwd"]?.value as? String == self.cwd,
                  request.params["worktree"]?.value as? Bool == self.worktree
            else { throw URLError(.badServerResponse) }
            let key = request.params["key"]?.value as? String ?? ""
            let category = request.params["category"]?.value as? String
            self.rows.append(OpenClawChatSessionEntry(key: key, displayName: "New grouped session", category: category))
            return try JSONEncoder().encode(OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: key))
        default: throw URLError(.unsupportedURL)
        }
        return try JSONSerialization.data(withJSONObject: [
            "ok": true, "groups": self.names.enumerated().map { ["name": $0.element, "position": $0.offset] },
        ])
    }
}
