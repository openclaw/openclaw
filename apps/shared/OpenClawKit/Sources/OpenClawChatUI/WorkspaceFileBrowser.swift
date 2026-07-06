// Read-only agent workspace file browser shared by the mobile apps (#100705).
// Backed by the `agents.workspace.list` / `agents.workspace.read` gateway RPCs.
import Foundation
import OpenClawProtocol
import SwiftUI

/// Sends one gateway RPC and returns the raw result payload for decoding.
public typealias WorkspaceGatewayRequester = @Sendable (_ method: String, _ paramsJSON: String) async throws
    -> Data

enum WorkspaceBrowserLoader {
    static func listParamsJSON(agentId: String, path: String, offset: Int?) throws -> String {
        let params = AgentsWorkspaceListParams(
            agentid: agentId,
            path: path.isEmpty ? nil : path,
            offset: offset)
        return try self.encode(params)
    }

    static func readParamsJSON(agentId: String, path: String) throws -> String {
        try self.encode(AgentsWorkspaceReadParams(agentid: agentId, path: path))
    }

    static func list(
        agentId: String,
        path: String,
        offset: Int?,
        requester: WorkspaceGatewayRequester) async throws -> AgentsWorkspaceListResult
    {
        let paramsJSON = try self.listParamsJSON(agentId: agentId, path: path, offset: offset)
        let data = try await requester("agents.workspace.list", paramsJSON)
        return try JSONDecoder().decode(AgentsWorkspaceListResult.self, from: data)
    }

    static func read(
        agentId: String,
        path: String,
        requester: WorkspaceGatewayRequester) async throws -> AgentsWorkspaceFile
    {
        let paramsJSON = try self.readParamsJSON(agentId: agentId, path: path)
        let data = try await requester("agents.workspace.read", paramsJSON)
        return try JSONDecoder().decode(AgentsWorkspaceReadResult.self, from: data).file
    }

    private static func encode(_ params: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(params)
        return String(decoding: data, as: UTF8.self)
    }
}

enum WorkspaceFileSupport {
    static func isDirectory(_ entry: AgentsWorkspaceEntry) -> Bool {
        (entry.kind.value as? String) == "directory"
    }

    static func isBase64(_ file: AgentsWorkspaceFile) -> Bool {
        (file.encoding.value as? String) == "base64"
    }

    /// Maps a filename to the chat code highlighter's language ids; nil renders plain.
    static func languageId(forFileName name: String) -> String? {
        let ext = (name as NSString).pathExtension.lowercased()
        return ChatCodeHighlighter.language(for: ext) != nil ? ext : nil
    }

    static func decodedImage(_ file: AgentsWorkspaceFile) -> OpenClawPlatformImage? {
        guard self.isBase64(file), let data = Data(base64Encoded: file.content) else { return nil }
        return OpenClawPlatformImage(data: data)
    }

    static func byteLabel(_ size: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    /// Writes the file to a unique temp path so share sheets export it under its real name.
    static func exportURL(for file: AgentsWorkspaceFile) throws -> URL {
        let data = if self.isBase64(file) {
            Data(base64Encoded: file.content) ?? Data()
        } else {
            Data(file.content.utf8)
        }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-export-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(file.name.isEmpty ? "file" : file.name)
        try data.write(to: url)
        return url
    }
}

/// One directory level of the read-only workspace browser. The host app owns
/// navigation: `onOpen` fires for both subdirectories and file previews.
public struct WorkspaceDirectoryView: View {
    private let agentId: String
    private let path: String
    private let requester: WorkspaceGatewayRequester
    private let onOpen: (AgentsWorkspaceEntry) -> Void

    @State private var entries: [AgentsWorkspaceEntry] = []
    @State private var truncated = false
    @State private var loading = true
    @State private var errorText: String?

    public init(
        agentId: String,
        path: String = "",
        requester: @escaping WorkspaceGatewayRequester,
        onOpen: @escaping (AgentsWorkspaceEntry) -> Void)
    {
        self.agentId = agentId
        self.path = path
        self.requester = requester
        self.onOpen = onOpen
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let errorText = self.errorText {
                self.statusRow(icon: "exclamationmark.triangle", text: errorText)
                Button {
                    Task { await self.reload() }
                } label: {
                    Text("Retry")
                        .font(OpenClawChatTypography.footnoteSemiBold)
                }
                .buttonStyle(.bordered)
            } else if self.loading, self.entries.isEmpty {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading files…")
                        .font(OpenClawChatTypography.footnote)
                        .foregroundStyle(.secondary)
                }
            } else if self.entries.isEmpty {
                self.statusRow(icon: "folder", text: "This folder is empty.")
            } else {
                self.entryList
            }
        }
        .task(id: "\(self.agentId)|\(self.path)") {
            await self.reload()
        }
    }

    private var entryList: some View {
        VStack(spacing: 0) {
            ForEach(Array(self.entries.enumerated()), id: \.element.path) { index, entry in
                Button {
                    self.onOpen(entry)
                } label: {
                    self.entryRow(entry)
                }
                .buttonStyle(.plain)
                if index < self.entries.count - 1 {
                    Divider().padding(.leading, 44)
                }
            }
            if self.truncated {
                Divider().padding(.leading, 44)
                Button {
                    Task { await self.loadMore() }
                } label: {
                    HStack {
                        if self.loading {
                            ProgressView()
                        }
                        Text("Load more")
                            .font(OpenClawChatTypography.footnoteSemiBold)
                            .foregroundStyle(OpenClawChatTheme.accent)
                    }
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .disabled(self.loading)
            }
        }
    }

    private func entryRow(_ entry: AgentsWorkspaceEntry) -> some View {
        let isDirectory = WorkspaceFileSupport.isDirectory(entry)
        return HStack(spacing: 12) {
            Image(systemName: isDirectory ? "folder" : "doc.text")
                .foregroundStyle(isDirectory ? OpenClawChatTheme.accent : Color.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                    .lineLimit(1)
                if let size = entry.size, !isDirectory {
                    Text(WorkspaceFileSupport.byteLabel(size))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func statusRow(icon: String, text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
            Text(text)
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 8)
    }

    private func reload() async {
        self.loading = true
        self.errorText = nil
        defer { self.loading = false }
        do {
            let result = try await WorkspaceBrowserLoader.list(
                agentId: self.agentId,
                path: self.path,
                offset: nil,
                requester: self.requester)
            self.entries = result.entries
            self.truncated = result.truncated == true
        } catch {
            self.errorText = error.localizedDescription
        }
    }

    private func loadMore() async {
        self.loading = true
        defer { self.loading = false }
        do {
            let result = try await WorkspaceBrowserLoader.list(
                agentId: self.agentId,
                path: self.path,
                offset: self.entries.count,
                requester: self.requester)
            self.entries += result.entries
            self.truncated = result.truncated == true
        } catch {
            self.errorText = error.localizedDescription
        }
    }
}

/// Read-only preview for one workspace file: syntax-highlighted text or an
/// image, with a share-sheet export of the exact bytes.
public struct WorkspaceFilePreviewView: View {
    private let agentId: String
    private let path: String
    private let requester: WorkspaceGatewayRequester

    @State private var file: AgentsWorkspaceFile?
    @State private var exportURL: URL?
    @State private var loading = true
    @State private var errorText: String?

    public init(agentId: String, path: String, requester: @escaping WorkspaceGatewayRequester) {
        self.agentId = agentId
        self.path = path
        self.requester = requester
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let errorText = self.errorText {
                Text(errorText)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            } else if let file = self.file {
                self.metadataRow(file)
                self.contentView(file)
            } else if self.loading {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Loading preview…")
                        .font(OpenClawChatTypography.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .toolbar {
            if let exportURL = self.exportURL {
                ToolbarItem(placement: .primaryAction) {
                    ShareLink(item: exportURL) {
                        Image(systemName: "square.and.arrow.up")
                    }
                }
            }
        }
        .task(id: "\(self.agentId)|\(self.path)") {
            await self.load()
        }
    }

    private func metadataRow(_ file: AgentsWorkspaceFile) -> some View {
        HStack(spacing: 8) {
            Text(WorkspaceFileSupport.byteLabel(file.size))
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
            if let mimeType = file.mimetype {
                Text(mimeType)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func contentView(_ file: AgentsWorkspaceFile) -> some View {
        if WorkspaceFileSupport.isBase64(file) {
            if let image = WorkspaceFileSupport.decodedImage(file) {
                OpenClawPlatformImageFactory.image(image)
                    .resizable()
                    .scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
            } else {
                Text("This image could not be decoded.")
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            ScrollView([.horizontal, .vertical]) {
                Text(self.highlightedText(file))
                    .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(OpenClawChatTheme.subtleCard)
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
        }
    }

    private func highlightedText(_ file: AgentsWorkspaceFile) -> AttributedString {
        ChatCodeHighlightCache.highlighted(
            code: file.content,
            languageId: WorkspaceFileSupport.languageId(forFileName: file.name))
    }

    private func load() async {
        self.loading = true
        self.errorText = nil
        defer { self.loading = false }
        do {
            let file = try await WorkspaceBrowserLoader.read(
                agentId: self.agentId,
                path: self.path,
                requester: self.requester)
            self.file = file
            self.exportURL = try? WorkspaceFileSupport.exportURL(for: file)
        } catch {
            self.errorText = error.localizedDescription
        }
    }
}
