import OpenClawChatUI
import SwiftUI

struct SessionArtifactsScreen: View {
    let sessionTitle: String
    @Environment(\.dismiss) private var dismiss
    @State private var model: IOSSessionArtifactsModel

    init(
        sessionTitle: String,
        acquire: @escaping @Sendable () async throws -> IOSSessionArtifactAccess)
    {
        self.sessionTitle = sessionTitle
        self._model = State(initialValue: IOSSessionArtifactsModel(acquire: acquire))
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(self.sessionTitle)
                            .font(OpenClawType.headline)
                            .textSelection(.enabled)
                        Text("Files shared in this conversation")
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    self.filterMenu
                }
                if let error = self.model.errorMessage {
                    Section {
                        Text(error)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                        Button {
                            Task { await self.model.refresh() }
                        } label: {
                            Label {
                                Text("Try again").font(OpenClawType.subheadMedium)
                            } icon: {
                                Image(systemName: "arrow.clockwise")
                            }
                        }
                        .disabled(self.model.isLoading)
                    }
                    .accessibilityIdentifier("artifacts-error")
                }
                if self.model.isLoading, !self.model.hasLoaded {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text("Loading artifacts…").font(OpenClawType.body)
                    }
                    .accessibilityIdentifier("artifacts-loading")
                } else if self.model.hasLoaded, self.model.filteredArtifacts.isEmpty {
                    self.emptyState
                }
                Section {
                    ForEach(self.model.filteredArtifacts) { artifact in
                        NavigationLink {
                            SessionArtifactDetail(artifact: artifact, load: { try await self.model.download(artifact) })
                        } label: {
                            self.row(artifact)
                        }
                        .accessibilityIdentifier("artifact-row-\(artifact.id)")
                    }
                } footer: {
                    if self.model.isPartial {
                        Text("Some artifacts could not be included. Search covers the items shown here.")
                            .font(OpenClawType.footnote)
                    } else if !self.model.artifacts.isEmpty {
                        Text("Search filters this collection. Workspace files are available separately in Pages.")
                            .font(OpenClawType.footnote)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Artifacts")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: self.$model.searchText,
                prompt: Text("Search artifacts").font(OpenClawType.body))
            .refreshable { await self.model.refresh() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { self.dismiss() } label: {
                        Text("Done").font(OpenClawType.body)
                    }
                    .accessibilityIdentifier("artifacts-done")
                }
            }
            .task { await self.model.refresh() }
            .accessibilityIdentifier("session-artifacts")
        }
    }

    private var filterMenu: some View {
        Picker(selection: self.$model.category) {
            ForEach(IOSSessionArtifact.Category.allCases) { category in
                Text(category.title)
                    .font(OpenClawType.subhead)
                    .tag(category)
            }
        } label: {
            Label {
                Text("Type").font(OpenClawType.subhead)
            } icon: {
                Image(systemName: "line.3.horizontal.decrease")
            }
        }
        .pickerStyle(.menu)
        .accessibilityIdentifier("artifact-type-filter")
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: self.model.artifacts.isEmpty ? "tray" : "magnifyingglass")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
            Text(self.model.artifacts.isEmpty ? "No artifacts yet" : "No matching artifacts")
                .font(OpenClawType.headline)
            Text(self.model.artifacts.isEmpty
                ? "Files available from this conversation will appear here."
                : "Try another name or choose a different type.")
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
        .accessibilityIdentifier("artifacts-empty")
    }

    private func row(_ artifact: IOSSessionArtifact) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: artifact.symbol)
                .font(.system(size: 22))
                .foregroundStyle(OpenClawBrand.accent)
                .frame(width: 32, height: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(artifact.title)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .foregroundStyle(.primary)
                Text(artifact.canDownload
                    ? [artifact.category.title, artifact.sizeDescription].compactMap(\.self).joined(separator: " · ")
                    : String(localized: "Download unavailable"))
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 3)
        }
        .accessibilityElement(children: .combine)
    }
}
