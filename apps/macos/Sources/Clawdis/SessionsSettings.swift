import AppKit
import SwiftUI

@MainActor
struct SessionsSettings: View {
    private let isPreview: Bool
    @State private var rows: [SessionRow]
    @State private var storePath: String = SessionLoader.defaultStorePath
    @State private var lastLoaded: Date?
    @State private var errorMessage: String?
    @State private var loading = false
    @State private var hasLoaded = false

    init(rows: [SessionRow]? = nil, isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self._rows = State(initialValue: rows ?? [])
        self.isPreview = isPreview
        if isPreview {
            self._lastLoaded = State(initialValue: Date())
            self._hasLoaded = State(initialValue: true)
        }
    }

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
            guard !self.isPreview else { return }
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
                .buttonStyle(.bordered)
                .help("Refresh session store")

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
                List(self.rows) { row in
                    self.sessionRow(row)
                }
                .listStyle(.inset)
            }
        }
    }

    @ViewBuilder
    private func sessionRow(_ row: SessionRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.key)
                    .font(.subheadline.bold())
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text(row.ageText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text("Context")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(row.tokens.contextSummaryShort)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                ContextUsageBar(
                    usedTokens: row.tokens.total,
                    contextTokens: row.tokens.contextTokens,
                    width: nil)
            }

            HStack(spacing: 10) {
                if let model = row.model, !model.isEmpty {
                    self.label(icon: "cpu", text: model)
                }
                self.label(icon: "arrow.down.left", text: "\(row.tokens.input) in")
                self.label(icon: "arrow.up.right", text: "\(row.tokens.output) out")
                if let sessionId = row.sessionId, !sessionId.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "number").foregroundStyle(.secondary).font(.caption)
                        Text(sessionId)
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .help(sessionId)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func label(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon).foregroundStyle(.secondary).font(.caption)
            Text(text)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
    }

    private func refresh() async {
        guard !self.loading else { return }
        guard !self.isPreview else { return }
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

#if DEBUG
struct SessionsSettings_Previews: PreviewProvider {
    static var previews: some View {
        SessionsSettings(rows: SessionRow.previewRows, isPreview: true)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
