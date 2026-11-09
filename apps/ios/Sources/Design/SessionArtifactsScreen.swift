import OpenClawChatUI
import SwiftUI

struct SessionArtifactsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model: IOSSessionArtifactsModel

    init(
        acquire: @escaping @Sendable () async throws -> IOSSessionArtifactAccess)
    {
        self._model = State(initialValue: IOSSessionArtifactsModel(acquire: acquire))
    }

    var body: some View {
        NavigationStack {
            List {
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
                        Text("Loading outputs…").font(OpenClawType.body)
                    }
                    .accessibilityIdentifier("artifacts-loading")
                } else if self.model.hasLoaded, self.model.artifacts.isEmpty {
                    self.emptyState
                }
                Section {
                    ForEach(self.model.artifacts) { artifact in
                        NavigationLink {
                            SessionArtifactDetail(artifact: artifact, load: { try await self.model.download(artifact) })
                        } label: {
                            self.row(artifact)
                        }
                        .accessibilityIdentifier("artifact-row-\(artifact.id)")
                    }
                } header: {
                    Text("Files shared in this conversation")
                        .font(OpenClawType.footnote)
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                        .accessibilityRemoveTraits(.isHeader)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Outputs")
            .navigationBarTitleDisplayMode(.inline)
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

    private var emptyState: some View {
        Text("No outputs yet")
            .font(OpenClawType.body)
            .foregroundStyle(.secondary)
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
