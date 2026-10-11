import Observation
import OpenClawProtocol
import SwiftUI

@MainActor
@Observable
public final class ChatSessionGroupDefaultsModel: Identifiable {
    public nonisolated var id: ObjectIdentifier {
        ObjectIdentifier(self)
    }

    let name: String
    let connection: OpenClawSessionMenuConnection
    let agentWorkspace: String?
    var cwd = ""
    var worktree = false {
        didSet { self.failure = nil }
    }

    var saved: SessionGroupDefaults?
    var loading = false
    var submitting = false
    var repository: WorktreeRepositoryStatus?
    var failure: String?
    var browserVisible = false
    var listing: FsListDirResult?
    var draft = ""
    var browsing = false
    var browserError: String?
    var highlighted: String?
    private var repositoryGeneration = 0
    private var browserGeneration = 0
    private var typedLoad: Task<Void, Never>?

    public init(name: String, connection: OpenClawSessionMenuConnection, agentWorkspace: String?) {
        self.name = name
        self.connection = connection
        self.agentWorkspace = agentWorkspace
    }

    var canSave: Bool {
        self.saved != nil && !self.loading && !self.submitting &&
            (self.repository == .git || self.repository == .notGit)
    }

    func load() async {
        guard !self.loading else { return }
        self.loading = true
        self.failure = nil
        defer { self.loading = false }
        do {
            let result: SessionsGroupsDefaultsResult = try await self.connection.read("sessions.groups.defaults")
            guard let saved = result.defaults.first(where: { $0.name == self.name }) else {
                self.failure = String(localized: "This group is no longer available.")
                return
            }
            self.saved = saved
            self.cwd = (saved.cwd ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            await self.inspect(restoreSaved: true)
        } catch { self.failure = error.localizedDescription }
    }

    func select(_ path: String) async {
        self.cwd = path.trimmingCharacters(in: .whitespacesAndNewlines)
        self.closeBrowser()
        await self.inspect(restoreSaved: false)
    }

    func inspect(restoreSaved: Bool) async {
        self.repositoryGeneration += 1
        let generation = self.repositoryGeneration
        self.repository = nil
        self.worktree = false
        self.failure = nil
        // ui/src/components/session-group-defaults-dialog.ts:102–123: generations reject A→B→A replies;
        // only initial validation or Retry of the original folder may restore the saved worktree mode.
        let path = (self.cwd.isEmpty ? self.agentWorkspace ?? "" : self.cwd)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var result: WorktreeRepositoryStatus = .unavailable
        if !path.isEmpty, let browser = self.connection.groupDefaultsBrowser {
            result = await (try? browser.inspectRepository(path)) ?? .unavailable
        }
        guard generation == self.repositoryGeneration else { return }
        self.repository = self.connection.isCurrent() && !Task.isCancelled ? result : .unavailable
        self.worktree = self.repository == .git && restoreSaved && self.saved?.worktree == true
    }

    func save() async -> Bool {
        guard self.canSave else { return false }
        self.submitting = true
        self.failure = nil
        defer { self.submitting = false }
        do {
            try await self.connection.request(OpenClawChatGatewayRequests.groupDefaultsUpdate(
                name: self.name, cwd: self.cwd, worktree: self.repository == .git && self.worktree))
            return true
        } catch {
            self.failure = self.connection.isCurrent() ? error
                .localizedDescription :
                String(localized: "Gateway connection changed. Close and reopen group defaults.")
            return false
        }
    }

    func close() {
        self.repositoryGeneration += 1
        self.closeBrowser()
    }

    func closeBrowser() {
        self.typedLoad?.cancel()
        self.browserGeneration += 1
        self.browserVisible = false
        self.listing = nil
        self.draft = ""
        self.browsing = false
        self.browserError = nil
        self.highlighted = nil
    }

    func navigate(_ path: String?) async {
        self.typedLoad?.cancel()
        self.browserGeneration += 1
        self.browserVisible = true
        self.draft = path ?? ""
        self.browserError = nil
        self.browsing = true
        await self.loadDirectory(path, navigation: true, generation: self.browserGeneration)
    }

    func editDraft(_ value: String) {
        self.typedLoad?.cancel()
        self.browserGeneration += 1
        let generation = self.browserGeneration
        self.draft = value
        self.highlighted = nil
        self.browserError = nil
        guard let split = Self.split(value), !self.inLoadedDirectory else { self.browsing = false
            return
        }
        self.browsing = true
        self.typedLoad = Task {
            // ui/src/pages/new-session/place-browser-state.ts:13,61: retire replies immediately,
            // but wait for typing to settle before reading another Gateway directory.
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            await self.loadDirectory(split.directory, navigation: false, generation: generation)
        }
    }

    private func loadDirectory(_ path: String?, navigation: Bool, generation: Int) async {
        defer { if generation == self.browserGeneration { self.browsing = false } }
        do {
            guard let browser = self.connection.groupDefaultsBrowser else { throw CancellationError() }
            let listing = try await browser.listDirectory(path)
            guard generation == self.browserGeneration, self.connection.isCurrent(), !Task.isCancelled else { return }
            self.listing = listing
            if navigation { self.draft = listing.path }
            self.highlighted = nil
        } catch {
            guard generation == self.browserGeneration else { return }
            if navigation {
                self.browserError = self.browserError ?? error.localizedDescription
                // ui/src/pages/new-session/place-browser-state.ts:153–165: an initial bad path
                // falls back once to the Gateway root, retaining the navigation failure.
                if self.listing == nil, path != nil {
                    self.draft = ""
                    await self.loadDirectory(nil, navigation: true, generation: generation)
                }
            }
        }
    }

    var usablePath: String? {
        let value = self.draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || Self.absolute(value) ? value : nil
    }

    private var inLoadedDirectory: Bool {
        guard let listing else { return false }
        return Self.samePath(self.draft, listing.path) || Self.split(self.draft).map {
            Self.samePath($0.directory, listing.path)
        } != false
    }

    var entries: [FsDirEntry] {
        guard let listing else { return [] }
        guard let split = Self.split(self.draft), !Self.samePath(self.draft, listing.path) else {
            return listing.entries
        }
        guard Self.samePath(split.directory, listing.path) else { return [] }
        // ui/src/pages/new-session/place-browser-view.ts:26–52: exact spelling leads;
        // hidden folders participate in filtering only when the prefix starts with a dot.
        let prefix = split.prefix
        return listing.entries.enumerated().compactMap { index, entry -> (Int, Int, FsDirEntry)? in
            if prefix.isEmpty { return (0, index, entry) }
            if entry.hidden == true && !prefix.hasPrefix(".") { return nil }
            let name = entry.name.lowercased(), query = prefix.lowercased()
            let rank = entry.name == prefix ? 0 : name == query ? 1 : name.hasPrefix(query) ? 2 : 3
            return name.contains(query) ? (rank, index, entry) : nil
        }.sorted { ($0.0, $0.1) < ($1.0, $1.1) }.map(\.2)
    }

    var hasNoSubfolders: Bool {
        guard let listing else { return false }
        guard let split = Self.split(self.draft) else { return true }
        return Self.samePath(self.draft, listing.path) ||
            (Self.samePath(split.directory, listing.path) && split.prefix.isEmpty)
    }

    var highlightedEntry: FsDirEntry? {
        self.entries.first { $0.path == self.highlighted } ?? self.entries.first
    }

    func moveHighlight(_ delta: Int) {
        let entries = self.entries
        guard !entries.isEmpty else { return }
        let current = entries.firstIndex { $0.path == self.highlighted } ?? 0
        self.highlighted = entries[(current + delta + entries.count) % entries.count].path
    }

    func activate() async {
        guard let path = self.usablePath else { return }
        await self.navigate(self.highlightedEntry?.path ?? (path.isEmpty ? nil : path))
    }

    func completeHighlighted() -> Bool {
        guard let entry = self.highlightedEntry,
              self.draft.trimmingCharacters(in: .whitespacesAndNewlines) != entry.path else { return false }
        self.editDraft(entry.path)
        return true
    }

    static func absolute(_ path: String) -> Bool {
        path.hasPrefix("/") || path.hasPrefix("\\") || path
            .range(of: #"^[A-Za-z]:[/\\]"#, options: .regularExpression) != nil
    }

    static func split(_ raw: String) -> (directory: String, prefix: String)? {
        let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.absolute(path) else { return nil }
        let root = path.range(of: #"^[A-Za-z]:[/\\]"#, options: .regularExpression) != nil ? 3 : 1
        let trailing = path.range(of: #"[/\\]+$"#, options: .regularExpression)
        let separator = trailing?.lowerBound ?? path.lastIndex(where: { $0 == "/" || $0 == "\\" })!
        let end = max(path.index(path.startIndex, offsetBy: root), separator)
        return (String(path[..<end]), trailing == nil ? String(path[path.index(after: separator)...]) : "")
    }

    static func samePath(_ a: String, _ b: String) -> Bool {
        func normalize(_ raw: String) -> String? {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard Self.absolute(trimmed) else { return nil }
            let path = trimmed.replacingOccurrences(of: "\\", with: "/")
            let drive = path.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) != nil
            let unc = path.hasPrefix("//")
            let floor = drive ? 1 : unc ? 2 : 0
            var parts: [Substring] = []
            for part in path.split(separator: "/") where part != "." {
                if part == ".." { if parts.count > floor { parts.removeLast() } } else { parts.append(part) }
            }
            let result = (unc ? "//" : path.hasPrefix("/") ? "/" : "") + parts.joined(separator: "/")
            return drive || unc ? result.lowercased() : result.isEmpty ? "/" : result
        }
        return normalize(a).map { $0 == normalize(b) } ?? false
    }
}

public struct ChatSessionGroupDefaultsSheet: View {
    @State private var model: ChatSessionGroupDefaultsModel
    @Environment(\.dismiss) private var dismiss

    public init(model: ChatSessionGroupDefaultsModel) {
        self._model = State(initialValue: model)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Group defaults").font(OpenClawChatTypography.headline)
            Text(verbatim: self.model.name).foregroundStyle(.secondary)
            Text("Choose the folder and working copy for new sessions in this group.")
            if self.model.saved != nil {
                Text(self.model.cwd.isEmpty ? String(localized: "Agent workspace") : self.model.cwd)
                    .textSelection(.enabled)
                HStack {
                    Button("Agent workspace") { Task { await self.model.select("") } }
                    Button("Browse…") {
                        Task { await self.model.navigate(self.model.cwd.isEmpty ? nil : self.model.cwd) }
                    }
                }.disabled(self.model.submitting)
                if self.model.browserVisible { self.browser }
                if self.model.repository == .git {
                    Toggle("Separate working copy", isOn: self.$model.worktree).disabled(self.model.submitting)
                } else if self.model.repository == nil {
                    ProgressView("Checking folder…")
                } else if self.model.repository == .notGit {
                    Text("Use the selected folder directly.")
                } else {
                    Text("Folder unavailable.").foregroundStyle(OpenClawChatTheme.danger)
                    Button("Retry") { Task { await self.model.inspect(
                        restoreSaved: self.model.cwd == (self.model.saved?.cwd ?? "")
                            .trimmingCharacters(in: .whitespacesAndNewlines)) } }
                }
            } else if self.model.loading { ProgressView() }
            if let failure = self.model.failure {
                Text(verbatim: failure).foregroundStyle(OpenClawChatTheme.danger).textSelection(.enabled)
                if self.model.saved == nil {
                    Button("Retry") { Task { await self.model.load() } }.disabled(self.model.loading)
                }
            }
            HStack {
                Spacer()
                Button("Cancel") { self.dismiss() }
                    .keyboardShortcut(.cancelAction).disabled(self.model.submitting)
                Button("Save") { Task { if await self.model.save() { self.dismiss() } } }
                    .keyboardShortcut(.defaultAction).disabled(!self.model.canSave)
            }
        }
        .padding(20)
        #if os(macOS)
        .frame(width: 460)
        #else
        .frame(maxWidth: .infinity, alignment: .leading)
        #endif
        .font(OpenClawChatTypography.body)
        .interactiveDismissDisabled(self.model.submitting)
        // NSHostingMenu does not mount appearance tasks; the presented sheet owns loading and Retry.
        .task { await self.model.load() }
        .onDisappear { self.model.close() }
    }

    private var browser: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { Task {
                    if let parent = self.model.listing?.parent {
                        await self.model.navigate(parent)
                    } else {
                        self.model.closeBrowser()
                    }
                } } label: { Image(systemName: "arrow.up") }
                    .help("Parent folder")
                TextField("Folder", text: Binding(get: { self.model.draft }, set: { self.model.editDraft($0) }))
                    .onSubmit { Task { await self.model.activate() } }
                    .onKeyPress(.downArrow) { self.model.moveHighlight(1)
                        return .handled
                    }
                    .onKeyPress(.upArrow) { self.model.moveHighlight(-1)
                        return .handled
                    }
                    .onKeyPress(keys: [.tab]) { press in
                        !press.modifiers.contains(.shift) && self.model.completeHighlighted() ? .handled : .ignored
                    }
                Button { self.model.closeBrowser() } label: { Image(systemName: "xmark") }.help("Close")
            }
            if self.model.browsing { ProgressView() }
            if let error = self.model.browserError {
                Text(verbatim: error).foregroundStyle(OpenClawChatTheme.danger)
                Button("Retry") { Task { await self.model.navigate(self.model.usablePath) } }
            }
            List(selection: Binding(get: { self.model.highlightedEntry?.path }, set: { self.model.highlighted = $0 })) {
                ForEach(self.model.entries, id: \.path) { entry in
                    Button { Task { await self.model.navigate(entry.path) } } label: {
                        Label(entry.name, systemImage: "folder").opacity(entry.hidden == true ? 0.5 : 1)
                    }.tag(entry.path).buttonStyle(.plain)
                }
            }.frame(height: 180)
            if self.model.entries.isEmpty, !self.model.browsing {
                Text(self.model
                    .hasNoSubfolders ? String(localized: "No subfolders") : String(localized: "No matching folders"))
                    .foregroundStyle(.secondary)
            }
            Button("Use this folder") { Task { if let path = self.model.usablePath { await self.model.select(path) } } }
                .disabled(self.model.usablePath == nil)
        }
        .disabled(self.model.submitting)
        .onKeyPress(.escape) { self.model.closeBrowser()
            return .handled
        }
    }
}
