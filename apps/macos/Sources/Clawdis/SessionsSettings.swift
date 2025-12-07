import AppKit
import SwiftUI

@MainActor
struct SessionsSettings: View {
    @State private var rows: [SessionRow] = []
    @State private var storePath: String = SessionLoader.defaultStorePath
    @State private var lastLoaded: Date?
    @State private var errorMessage: String?
    @State private var loading = false
    @State private var hasLoaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.header
            self.storeMetadata
            Divider().padding(.vertical, 4)
            self.content
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .task {
            guard !self.hasLoaded else { return }
            self.hasLoaded = true
            await self.refresh()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Sessions")
                .font(.title3.weight(.semibold))
            Text("Peek at the stored conversation buckets the CLI reuses for context and rate limits.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var storeMetadata: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Session store")
                        .font(.callout.weight(.semibold))
                    if let lastLoaded {
                        Text("Updated \(relativeAge(from: lastLoaded))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(self.storePath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }

            HStack(spacing: 10) {
                Button {
                    Task { await self.refresh() }
                } label: {
                    Label(self.loading ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                        .labelStyle(.titleAndIcon)
                }
                .disabled(self.loading)

                Button {
                    self.revealStore()
                } label: {
                    Label("Reveal", systemImage: "folder")
                        .labelStyle(.titleAndIcon)
                }
                .disabled(!FileManager.default.fileExists(atPath: self.storePath))

                if self.loading {
                    ProgressView().controlSize(.small)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private var content: some View {
        Group {
            if self.rows.isEmpty, self.errorMessage == nil {
                Text("No sessions yet. They appear after the first inbound message or heartbeat.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            } else {
                Table(self.rows) {
                    TableColumn("Key") { row in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.key)
                                .font(.body.weight(.semibold))
                            HStack(spacing: 6) {
                                if row.kind != .direct {
                                    SessionKindBadge(kind: row.kind)
                                }
                                if !row.flagLabels.isEmpty {
                                    ForEach(row.flagLabels, id: \.self) { flag in
                                        Badge(text: flag)
                                    }
                                }
                            }
                        }
                    }
                    .width(220)

                    TableColumn("Updated", value: \.ageText)
                        .width(70)

                    TableColumn("Tokens") { row in
                        Text(row.tokens.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(170)

                    TableColumn("Model") { row in
                        Text(row.model ?? "—")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(120)

                    TableColumn("Session ID") { row in
                        Text(row.sessionId ?? "—")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .tableStyle(.inset(alternatesRowBackgrounds: true))
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private func refresh() async {
        guard !self.loading else { return }
        self.loading = true
        self.errorMessage = nil

        let hints = SessionLoader.configHints()
        let resolvedStore = SessionLoader.resolveStorePath(override: hints.storePath)
        let defaults = SessionDefaults(
            model: hints.model ?? SessionLoader.fallbackModel,
            contextTokens: hints.contextTokens ?? SessionLoader.fallbackContextTokens)

        do {
            let newRows = try await SessionLoader.loadRows(at: resolvedStore, defaults: defaults)
            self.rows = newRows
            self.storePath = resolvedStore
            self.lastLoaded = Date()
        } catch {
            self.rows = []
            self.storePath = resolvedStore
            self.errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }

        self.loading = false
    }

    private func revealStore() {
        let url = URL(fileURLWithPath: storePath)
        if FileManager.default.fileExists(atPath: self.storePath) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }
}

private struct SessionKindBadge: View {
    let kind: SessionKind

    var body: some View {
        Text(self.kind.label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .foregroundStyle(self.kind.tint)
            .background(self.kind.tint.opacity(0.15))
            .clipShape(Capsule())
    }
}

private struct Badge: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .foregroundStyle(.secondary)
            .background(Color.secondary.opacity(0.12))
            .clipShape(Capsule())
    }
}
