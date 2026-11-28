import Foundation
import OpenClawChatUI
import OpenClawProtocol

enum ScreenshotFixtureMode {
    static func clockMediaHistory() throws -> [AnyCodable]? {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-clock-media-fixture") else { return nil }
        let yesterday = Int(Date.now.timeIntervalSince1970 * 1000) - 86_400_000
        // Exercise the sent-photo path with a synthetic mountain scene.
        let landscape = "iVBORw0KGgoAAAANSUhEUgAAAEgAAAAwCAIAAAA9/qu8AAAA90lEQVR42u3WTQoCMQwF4HdAjyOMV3Gh"
            + "Z5k7uBW8hyuRgUHoj2mbtkkm8JblkW8RGqzPl8nAYQ5z2NFh78d9ix3YTvqNelhURbc5TIyKaHOYw3zH"
            + "jgoz+49Zvjzm3IqX23WLKdiuEmtDu0qmDe0kmTwwqkTZwKuSYwMvSQ4PnVTTbeinYrRVtKEfiYVX3YYB"
            + "qjpbYyHGqIpsLJ0YQyLyGDsxWJWx8XZivCqcI/XmtJzDEGsxRZVJFJNKhgd1GCIS2j0pIWxgwqBlOGmY"
            + "eljRBk/x1MAoizsXUwyTMy4bTCPpP0yvKglTTYrDDJAiMDOqL8wSxmGa8wGVuQPLJjNLDgAAAABJRU5E"
            + "rkJggg=="
        return try JSONDecoder().decode([AnyCodable].self, from: Data(#"""
        [{"role":"user","timestamp":\#(yesterday),"__openclaw":{"id":"earlier"},
          "content":[{"type":"text","text":"From yesterday"}]},
         {"role":"user","timestamp":\#(yesterday + 1000),"__openclaw":{"id":"view"},
          "content":[{"type":"text","text":"Here’s the view"}]},
         {"role":"user","timestamp":\#(yesterday + 2000),"__openclaw":{"id":"landscape"},
          "content":[{"type":"image","mimeType":"image/png","fileName":"landscape.png","alt":"Mountain view",
                      "width":72,"height":48,"content":"\#(landscape)"}]}]
        """#.utf8))
    }

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

    static var chatInfoEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-chat-info-fixture")
    }

    @MainActor private static var infoReads: [String: Int] = [:]

    /// In-place loading proof: a reply slower than the old 5 s limit, one failure before the retry succeeds,
    /// or a failure on the second read only (the page reappearing after the gallery).
    @MainActor static func infoRead<Value>(
        _ section: String,
        _ read: () -> ChatInfoRead<Value>) async -> ChatInfoRead<Value>
    {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--openclaw-info-slow") { try? await Task.sleep(for: .seconds(7)) }
        let count = self.infoReads[section, default: 0] + 1
        self.infoReads[section] = count
        if args.contains("--openclaw-info-failed-once"), count == 1 { return .failed }
        if args.contains("--openclaw-info-failed-second"), count == 2 { return .failed }
        return read()
    }

    static func infoAutomations(_ query: CronListParams) -> ChatInfoRead<[ChatInfoAutomation]> {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--openclaw-info-loading") { return .loading }
        if args.contains("--openclaw-info-failed") { return .failed }
        guard args.contains("--openclaw-info-populated"),
              query.agentid == "main" || query.sessionkey == self.chatSwitchSecondSessionKey else { return .loaded([]) }
        let jobs: [ChatInfoAutomation] = [
            .init(
                id: "sweep",
                name: "Screenshot sweep",
                enabled: true,
                schedule: .init(kind: "every", everyMs: 21_600_000),
                lastRunStatus: "error"),
            .init(
                id: "release",
                name: "Release notes",
                enabled: false,
                schedule: .init(kind: "cron", expr: "0 9 * * FRI#2"),
                lastRunStatus: "ok"),
            .init(
                id: "brief",
                name: "Morning brief",
                enabled: true,
                schedule: .init(kind: "cron", expr: "0 17 * * MON-FRI"),
                lastRunStatus: "ok"),
        ]
        return .loaded(Array(jobs.prefix(query.limit ?? 0)))
    }

    static func infoMedia(for key: String) -> ChatInfoRead<[ArtifactSummary]> {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("--openclaw-info-loading") { return .loading }
        if args.contains("--openclaw-info-failed") { return .failed }
        if args.contains("--openclaw-info-main-media"), ["main", "agent:main:main"].contains(key) {
            return .loaded([ArtifactSummary(
                id: "main-notes",
                type: "file",
                title: "Main chat notes.pdf",
                mimetype: "application/pdf",
                download: ["mode": AnyCodable("bytes")])])
        }
        guard args.contains("--openclaw-info-populated"), !args.contains("--openclaw-info-automations-only"),
              key == self.chatSwitchSecondSessionKey else { return .loaded([]) }
        let prefix = "--openclaw-info-media-count="
        if let count = args.first(where: { $0.hasPrefix(prefix) }).flatMap({ Int($0.dropFirst(prefix.count)) }) {
            // Transcript order, oldest first; counted from the newest, every third item is a file.
            return .loaded((1...max(count, 1)).map { index in
                let fromNewest = (count - index) % 3
                let kind = fromNewest == 2 ? "notes" : fromNewest == 0 ? "palette" : "layout"
                let mime = kind == "notes" ? "application/pdf" : "image/png"
                return ArtifactSummary(
                    id: "\(kind)-\(index)",
                    type: kind == "notes" ? "file" : "image",
                    title: "\(kind)-\(index).\(mime.split(separator: "/").last ?? "")",
                    mimetype: mime,
                    sizebytes: 9800 * index,
                    messageseq: index,
                    download: ["mode": AnyCodable("bytes")])
            })
        }
        return .loaded([
            ArtifactSummary(
                id: "palette",
                type: "image",
                title: "Palette.png",
                mimetype: "image/png",
                messageseq: 3,
                download: ["mode": AnyCodable("bytes")]),
            ArtifactSummary(
                id: "layout",
                type: "image",
                title: "Layout.jpg",
                mimetype: "image/jpeg",
                messageseq: 2,
                download: ["mode": AnyCodable("bytes")]),
            ArtifactSummary(
                id: "notes",
                type: "file",
                title: "Notes.pdf",
                mimetype: "application/pdf",
                messageseq: 1,
                download: ["mode": AnyCodable("bytes")]),
        ])
    }

    @MainActor private static var infoThumbnailReads: [String: Int] = [:]

    /// Each artifact's first read fails, or every read after its first fails (a second download is a bug).
    @MainActor static func infoThumbnail(for item: ArtifactSummary) async throws -> ArtifactsDownloadResult {
        let reads = self.infoThumbnailReads[item.id, default: 0] + 1
        self.infoThumbnailReads[item.id] = reads
        let flags = ProcessInfo.processInfo.arguments
        if flags.contains("--openclaw-info-thumbnail-fails-first"), reads == 1 { throw URLError(.timedOut) }
        if flags.contains("--openclaw-info-thumbnail-once"), reads > 1 { throw URLError(.timedOut) }
        let encoded: String
        switch item.id.split(separator: "-").first.map(String.init) {
        case "palette":
            // Synthetic warm swatches, 156 × 104. This is an actual 274-byte lossless WebP rendition.
            encoded =
                "UklGRgoBAABXRUJQVlA4TP4AAAAvm8AZAC9AJm3j31AVVMvufWNOiLRt5t/gbAydXjEkSYzH+hukQzqG9Jj/6Pk8KdQi" +
                "bAOwGkmSXPVPAfAxBNoQTMDvIDAtFX8wO9vTVvk+pIj+T8Cx8uCVVnn6r/xiExxfCCZxCZiGHiehxmloxRy1WAilqKAS" +
                "S6ETNdRhMVSiiirMb5Z9gAuwGXehSLWVzYJ6m/Wuw2xLbBZQ22S7SmRaakOSN8Um30V4FrzytRxvDab6JWgZXgImukzk" +
                "2hqHpsaVfik46NTxmTxugDiD3QBeh5sgykzEqyATRSbjNRCKEhPyCkhFgUn5HMR8BqbmOZieZ2CXwGPF8kLuVvmtCA=="
        case "layout":
            let args = ProcessInfo.processInfo.arguments
            if args.contains("--openclaw-info-thumbnail-loading") { try await Task.sleep(for: .seconds(60)) }
            if args.contains("--openclaw-info-thumbnail-failed") { throw URLError(.cannotDecodeContentData) }
            // A blue layout study, 156 × 104; intentionally independent of the palette fixture.
            encoded =
                "UklGRnIAAABXRUJQVlA4TGUAAAAvm8AZAC9AmG2EMH+LUZzGPadEJEDyfwS/yJpNHlDUtg3En2Tvkdhr/iO/nHfaENgF" +
                "iiJbbf6gACygIMVCLMS/m36iHCL6PwEz48XPfkOfJFfyr08b6wBYDqdF71pe6YdTtH9zLwA="
        default: throw URLError(.fileDoesNotExist)
        }
        let preview = ArtifactSummary(
            id: item.id,
            type: "image",
            title: item.title,
            mimetype: "image/webp",
            download: ["mode": AnyCodable("bytes")])
        return ArtifactsDownloadResult(artifact: preview, encoding: "base64", data: encoded)
    }

    static func checkoutSummary(for key: String) -> SessionsDiffResult? {
        guard self.chatInfoEnabled, key == self.chatSwitchSecondSessionKey else { return nil }
        return SessionsDiffResult(sessionkey: key, files: [], additions: 2280, deletions: 327)
    }

    static func decorateChatInfo(_ session: inout OpenClawChatSessionEntry) {
        guard self.chatInfoEnabled else { return }
        session.worktree = OpenClawChatSessionWorktree(
            id: "review-notes",
            branch: "fix/preserve-review-previews-on-reopen",
            repoRoot: "/projects/review-notes")
        session.createdAt = 1_795_219_200_000
        session.totalTokens = 76000
        session.totalTokensFresh = true
        session.contextTokens = 200_000
    }

    static var chatSwitchSecondSessionTitle: String {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-chat-info-long-title-fixture")
        else { return "Launch plan" }
        return "Launch plan: review the draft notes and confirm the checklist " +
            "before the next release candidate is ready for a final pass"
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
    /// Every send fails the way a Gateway request times out, to show how a failed send reads.
    static var failsSends: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-send-timeout-fixture")
    }

    static let sendTimeoutError = NSError(domain: "Gateway", code: 5, userInfo: [
        NSLocalizedDescriptionKey: "gateway request timed out after 15000ms",
    ])

    /// The Gateway route claims no settings CAS, so a queued send fails before it leaves the phone.
    static var failsQueuedSendSettings: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-send-settings-failure-fixture")
    }

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

/// `--openclaw-session-states-fixture`: Sessions page rows in each state a row can show (approval with and
/// without a command, failure with a short, a long and no reason, subagents working, plain working, pinned,
/// grouped and long titles). The approvals are attention requests as `pendingApprovalAttentionRequests`
/// builds them; the subagents are hidden rows that `CommandCenterTab.listedSessions` folds into their parent.
extension ScreenshotFixtureMode {
    static var sessionStatesEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-session-states-fixture")
    }

    /// One clock for the fixture, so repeated reads return equal rows and requests.
    static let sessionStatesStart = Date()

    static func sessionStateRows(now: Date = Self.sessionStatesStart) -> [OpenClawChatSessionEntry] {
        let nowMs = now.timeIntervalSince1970 * 1000
        var rank = 0.0
        func fixtureSession(
            _ key: String,
            _ label: String,
            _ change: (inout OpenClawChatSessionEntry) -> Void = { _ in })
            -> OpenClawChatSessionEntry
        {
            rank += 1
            var entry = OpenClawChatSessionEntry(key: "agent:main:\(key)")
            entry.label = label
            entry.agentId = "main"
            entry.updatedAt = nowMs - rank * 60000
            change(&entry)
            return entry
        }
        return [
            fixtureSession(
                "rows-spinner",
                "Find out why the sidebar spinner keeps turning after the session ends on iPad"),
            fixtureSession("rows-fork-lander", "🛬 Fork lander"),
            fixtureSession("rows-approval-plain", "Rotate the staging keys"),
            fixtureSession("rows-screens", "Map the OpenClaw screens") {
                $0.status = "timeout"
                $0.unread = true
                $0.lastRunError = "Request timed out before a response was generated. Please try again, " +
                    "or increase `agents.defaults.timeoutSeconds` in your config."
            },
            fixtureSession("rows-rate-limit", "Nightly digest") {
                $0.status = "failed"
                $0.unread = true
                $0.lastRunError = "⚠️ clawrouter/anthropic/claude-opus-5-5 is rate-limited.\n\nPick another model " +
                    "in the model picker, or configure Model fallbacks in Settings."
            },
            fixtureSession("rows-failed-plain", "Import the old notes") {
                $0.status = "failed"
                $0.unread = true
            },
            fixtureSession("rows-mapping", "iOS mapping, tempbook") { $0.hasActiveRun = true },
            fixtureSession("rows-icons", "⏳ Redo the OpenClaw icons") { $0.hasActiveRun = true },
            fixtureSession("rows-boards", "📐 PRINCIPAL - Boards / Designer") {
                $0.hasActiveRun = true
                $0.childSessions = ["agent:main:subagent:rows-boards-a", "agent:main:subagent:rows-boards-b"]
            },
            fixtureSession("subagent:rows-boards-a", "Board audit") {
                $0.parentSessionKey = "agent:main:rows-boards"
                $0.hasActiveRun = true
            },
            fixtureSession("subagent:rows-boards-b", "Board export") {
                $0.parentSessionKey = "agent:main:rows-boards"
                $0.hasActiveRun = true
            },
            fixtureSession("rows-avatar", "🎨 OpenClaw avatar") {
                $0.pinned = true
                $0.unread = true
            },
            fixtureSession("rows-onboarding", "🧭 Map the OpenClaw onboarding") { $0.pinned = true },
            fixtureSession("rows-film", "🎬 OpenClaw One Year — Film") { $0.pinned = true },
            fixtureSession("rows-videos", "Cut the launch video") { $0.category = "Videos" },
            fixtureSession(
                "rows-icon-sizes",
                "Standardize the size and alignment of the icons in the sidebar and the search"),
            fixtureSession("rows-recent", "Fix the session fixture"),
        ]
    }

    static func sessionStateApprovals(now: Date = Self.sessionStatesStart) -> [OpenClawChatAttentionRequest] {
        let nowMs = now.timeIntervalSince1970 * 1000
        return [
            ("rows-spinner", "xcrun simctl erase 3F2A-batch31"),
            ("rows-fork-lander", "gh pr merge 91342 --squash"),
            ("rows-approval-plain", ""),
        ].enumerated().map { index, item in
            OpenClawChatAttentionRequest(
                id: "rows-approval-\(index)",
                kind: .approval,
                sessionKey: "agent:main:\(item.0)",
                agentID: "main",
                createdAtMs: nowMs - Double(index) * 1000,
                expiresAtMs: nowMs + 3_600_000,
                preview: item.1)
        }
    }
}
