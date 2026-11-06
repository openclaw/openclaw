import Foundation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// Review is app-local, not a deep link or background send. Switching to the
/// original destination remains an explicit user action through existing UI.
struct SharedDraftImportReview: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var imports: [SharedDraftImport] = []
    @State private var isPresented = false
    @State private var isImporting = false
    @State private var message: String?

    var body: some View {
        Button {
            self.isPresented = true
        } label: {
            Label(
                String(format: String(localized: "Saved shares (%ld)"), self.imports.count),
                systemImage: "square.and.arrow.down")
                .font(OpenClawType.subheadSemiBold)
                .padding(10)
                .background(.regularMaterial, in: Capsule())
        }
        .accessibilityIdentifier("shared-drafts.review")
        .opacity(self.imports.isEmpty && self.message == nil ? 0 : 1)
        .allowsHitTesting(!self.imports.isEmpty || self.message != nil)
        .task { await self.reload() }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active { Task { await self.reload() } }
        }
        .sheet(isPresented: self.$isPresented) {
            NavigationStack {
                List {
                    if let message {
                        Text(message).font(OpenClawType.body)
                    }
                    ForEach(self.imports) { draft in
                        Section {
                            Text(verbatim: draft.text).font(OpenClawType.body)
                                .textSelection(.enabled)
                            ForEach(Array(draft.fileNames.enumerated()), id: \.offset) { _, name in
                                Label(name, systemImage: "doc").font(OpenClawType.body)
                            }
                            Text(verbatim: """
                            Gateway: \(draft.target.gatewayID)
                            Agent: \(draft.target.agentID)
                            Chat: \(draft.target.sessionKey)
                            """)
                                .font(OpenClawType.caption)
                            Text(String(
                                format: String(localized: "Expires %@. Nothing is sent automatically."),
                                draft.expiresAt.formatted(date: .abbreviated, time: .shortened)))
                                .font(OpenClawType.caption)
                            Button {
                                Task { await self.importDraft(draft) }
                            } label: {
                                Text("Import into original chat").font(OpenClawType.body)
                            }
                            .disabled(self.isImporting || !self.matches(draft.target))
                            Button(role: .destructive) {
                                Task {
                                    do {
                                        try await SharedDraftInbox.shared.discard(id: draft.id)
                                        await self.reload()
                                    } catch { self.message = error.localizedDescription }
                                }
                            } label: {
                                Text("Discard saved share").font(OpenClawType.body)
                            }
                            .disabled(self.isImporting)
                            if !self.matches(draft.target) {
                                Text("Select this Gateway, agent, and chat first. Your draft will not be replaced.")
                                    .font(OpenClawType.caption)
                            }
                        }
                    }
                }
                .navigationTitle("Saved shares")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { self.isPresented = false } label: {
                            Text("Done").font(OpenClawType.body)
                        }
                        .disabled(self.isImporting)
                    }
                }
            }
            .interactiveDismissDisabled(self.isImporting)
        }
    }

    private func matches(_ target: SharedDraftTarget) -> Bool {
        self.appModel.chatTranscriptCacheGatewayID == target.gatewayID &&
            self.appModel.chatDeliveryAgentId == target.agentID &&
            self.appModel.chatSessionKey == target.sessionKey &&
            self.appModel.chatPresentation.presentationAgentID == target.agentID &&
            self.appModel.chatPresentation.isCurrent(appModel: self.appModel) &&
            self.appModel.chatPresentation.viewModel?.sessionKey == target.sessionKey
    }

    @MainActor
    private func reload() async {
        do {
            self.imports = try await SharedDraftInbox.shared.pending()
        } catch {
            self.message = error.localizedDescription
        }
    }

    @MainActor
    private func importDraft(_ draft: SharedDraftImport) async {
        guard !self.isImporting, self.matches(draft.target),
              let model = self.appModel.chatPresentation.viewModel
        else { return }
        self.isImporting = true
        defer { self.isImporting = false }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-import-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let files = try await SharedDraftInbox.shared.materialize(id: draft.id, into: directory)
            guard files.count == draft.fileNames.count else { throw SharedDraftError.unreadable }
            let imported = await model.importSharedDraft(text: draft.text, files: files) {
                self.matches(draft.target) && self.appModel.chatPresentation.viewModel === model
            }
            guard imported else {
                self.message = model.errorText
                return
            }
            // The complete import is now in the original composer. Cleanup never precedes staging.
            try await SharedDraftInbox.shared.discard(id: draft.id)
            self.message = "Imported into the original chat. Review it and tap Send when ready."
            self.appModel.openChat(sessionKey: draft.target.sessionKey)
            await self.reload()
        } catch {
            self.message = error.localizedDescription
        }
    }
}
