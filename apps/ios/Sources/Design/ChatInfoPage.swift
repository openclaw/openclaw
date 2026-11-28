import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct ChatInfoPage: View {
    let visit: ChatInfoVisit
    let writesDisabled: Bool
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var scrolled = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmsReset = false
    @State private var transcriptShareItem: TranscriptShareItem?

    private struct TranscriptShareItem: Identifiable {
        let id = UUID()
        let fileURL: URL
    }

    private var isCurrent: Bool {
        self.appModel.chatPresentation.viewModel === self.visit.model &&
            self.visit.model.currentSessionTarget == self.visit.target
    }

    private var disabled: Bool {
        self.writesDisabled || !self.isCurrent
    }

    private var session: OpenClawChatSessionEntry? {
        self.isCurrent ? self.visit.model.currentSessionEntry() ?? self.visit.session : self.visit.session
    }

    private var title: String {
        guard !self.visit.isProfile, let session else { return self.visit.agentName }
        return SessionPresentation.title(session, includesRoutingFallback: false) ?? self.visit.agentName
    }

    var body: some View {
        self.page
            .onChange(of: self.visit.model.errorText) { _, error in
                if self.isCurrent,
                   let error { self.appModel.toasts.post(.failure(error)) }
            }
            .sheet(item: self.$transcriptShareItem) { item in
                OpenClawChatFileShareSheet(fileURL: item.fileURL)
            }
            .alert(Text("Rename chat"), isPresented: self.$renaming) {
                TextField(String(localized: "Chat name"), text: self.$newName).font(OpenClawType.body)
                Button { if !self.disabled, let session {
                    self.visit.model.renameSession(key: session.key, label: self.newName, agentID: session.agentId)
                } } label: { Text("Save").font(OpenClawType.body) }
                Button(role: .cancel) {} label: { Text("Cancel").font(OpenClawType.body) }
            }
    }

    private var resetNote: String {
        self.visit.isProfile
            ? String(
                format: String(localized: "Reset clears the messages in this chat. %@ and its workspace stay."),
                self.visit.agentName)
            : String(localized: "Reset clears the messages in this chat.")
    }

    private var page: some View {
        ScrollView(.vertical) { self.sections }
            // Both headers carry the title in the page; the bar shows it once the header scrolls away.
                .onScrollGeometryChange(for: Bool.self) {
                    $0.contentOffset.y + $0.contentInsets.top > (self.visit.isProfile ? 102 : 72)
                } action: { _, collapsed in self.scrolled = collapsed }
                .scrollEdgeEffectStyle(.soft, for: .top)
                .background((self.colorScheme == .dark ? OpenClawBrand.canvas : OpenClawBrand.surfaceMuted)
                    .ignoresSafeArea())
                .navigationTitle(self.scrolled ? self.title : "")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(.visible, for: .navigationBar)
                .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
                .toolbar {
                    if !self.visit.isProfile, self.scrolled {
                        ToolbarItem(placement: .principal) {
                            Text(verbatim: self.title).font(OpenClawType.headline)
                                .lineLimit(1).truncationMode(.tail)
                                .accessibilityIdentifier("chat-info-bar-title")
                        }
                    }
                    if !self.visit.isProfile, self.visit.session != nil {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button {
                                self.newName = self.session?.label ?? self.session?.displayName ?? ""
                                self.renaming = true
                            } label: { Text("Edit").font(OpenClawType.body) }
                                .accessibilityLabel(Text("Rename chat"))
                                .disabled(self.disabled)
                        }
                    }
                }
                .foregroundStyle(OpenClawBrand.textStrong).tint(.primary)
    }

    private var sections: some View {
        VStack(spacing: 24) {
            VStack(spacing: 22) {
                self.header
                self.actions
            }
            if let environment = self.visit.environment {
                ChatInfoSection("Environment") {
                    ChatInfoEnvironmentRow(environment: environment, changes: self.visit.checkoutChanges)
                }
            }
            if let pullRequests = self.visit.pullRequests {
                ChatInfoSection("Pull requests") { pullRequests }
            }
            ChatInfoMedia(visit: self.visit)
            ChatInfoSection("Automations") { ChatInfoAutomations(visit: self.visit) }
            if let original = self.visit.usage {
                ChatInfoSection("Context") {
                    ChatInfoContext(
                        usage: self.isCurrent ? self.visit.model.contextUsage ?? original : original,
                        canCompact: !self.disabled && self.visit.model.canRequestSessionCompact,
                        compact: { self.visit.model.requestSessionCompact() })
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, self.visit.isProfile ? -52 : 6).padding(.bottom, 24)
    }

    @ViewBuilder private var header: some View {
        if self.visit.isProfile {
            VStack(spacing: 14) {
                ChatInfoAvatar(visit: self.visit, size: 104)
                Text(verbatim: self.title).font(OpenClawType.title2)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("chat-info-agent-title")
            }.frame(maxWidth: .infinity)
        } else {
            VStack(spacing: 6) {
                ChatInfoAgentRow(visit: self.visit).padding(.bottom, 4)
                Text(verbatim: self.title).font(OpenClawType.title2)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("chat-info-session-title")
                if let created = self.visit.session?.createdAt {
                    let date = Date(timeIntervalSince1970: created / 1000)
                        .formatted(.dateTime.month(.abbreviated).day())
                    Text(verbatim: String(format: String(localized: "Created %@"), date)).font(OpenClawType.footnote)
                        .foregroundStyle(OpenClawBrand.textSecondary)
                }
            }.padding(.horizontal, 16).frame(maxWidth: .infinity)
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                self.action("Export", symbol: "square.and.arrow.up", perform: self.exportTranscript)
                    .accessibilityLabel(Text("Export chat"))
                    .disabled(!self.isCurrent || self.visit.model.isLoading)
                if ChatInfoVisit.offersArchive(
                    isProfile: self.visit.isProfile,
                    session: self.visit.session,
                    mainSessionKey: self.appModel.mainSessionKey)
                {
                    self.action("Archive", symbol: "archivebox") {
                        guard !self.disabled, let session,
                              ChatSessionSidebarModel.canArchiveSession(
                                  session,
                                  mainSessionKey: self.appModel.mainSessionKey)
                        else { return }
                        self.visit.model.setSessionArchived(session, archived: true)
                    }.disabled(self.disabled || !(self.session.map {
                        ChatSessionSidebarModel.canArchiveSession($0, mainSessionKey: self.appModel.mainSessionKey)
                    } ?? false))
                }
                self.action("Reset", symbol: "arrow.counterclockwise") { self.confirmsReset = true }
                    .accessibilityLabel(Text("Reset chat"))
                    .disabled(self.disabled || self.visit.model.isLoading)
                    .confirmationDialog(
                        Text("Reset this chat?"),
                        isPresented: self.$confirmsReset,
                        titleVisibility: .visible)
                    {
                        Button(role: .destructive) {
                            guard !self.disabled else { return }
                            self.visit.model.requestSessionReset()
                        } label: { Text("Reset chat").font(OpenClawType.body) }
                        Button(role: .cancel) {} label: { Text("Cancel").font(OpenClawType.body) }
                    } message: { Text(verbatim: self.resetNote).font(OpenClawType.body) }
            }
            // The agent profile keeps its note: Reset there must not read as removing the agent.
            if self.visit.isProfile {
                Text(verbatim: self.resetNote)
                    .font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.textSecondary).padding(.horizontal, 16)
            }
        }
    }

    private func action(_ label: LocalizedStringKey, symbol: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            VStack(spacing: 5) {
                // One icon box, so labels share a baseline whatever the glyph height.
                Image(systemName: symbol).font(OpenClawType.title3).frame(height: 26).accessibilityHidden(true)
                Text(label).font(OpenClawType.footnoteMedium)
            }
            .frame(maxWidth: .infinity, minHeight: 66)
            .background(OpenClawBrand.surfaceRaised, in: .rect(cornerRadius: 18)).contentShape(.rect)
        }.buttonStyle(.plain)
    }

    private func exportTranscript() {
        guard self.isCurrent, !self.visit.model.isLoading else { return }
        var directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenClawTranscripts", isDirectory: true)
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--openclaw-export-failure-fixture") {
            // UI tests: a folder that can't be created, so the write fails as a full disk would.
            directory = URL(fileURLWithPath: "/dev/null/OpenClawTranscripts", isDirectory: true)
        }
        #endif
        do {
            let fileURL = try Self.writeTranscript(for: self.visit.model, in: directory)
            self.transcriptShareItem = TranscriptShareItem(fileURL: fileURL)
        } catch {
            self.appModel.toasts.post(.failure(
                String(localized: "Couldn’t export this chat."),
                retry: { self.exportTranscript() }))
        }
    }

    static func writeTranscript(for viewModel: OpenClawChatViewModel, in directory: URL) throws -> URL {
        let title = viewModel.currentSessionEntry()?.displayName
        let key = viewModel.sessionKey
        let filename = ChatTranscriptExporter.filename(sessionTitle: title, sessionKey: key)
        let markdown = ChatTranscriptExporter.markdown(
            sessionTitle: title,
            sessionKey: key,
            messages: viewModel.messages)
        let fileURL = directory.appendingPathComponent(filename, isDirectory: false)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try markdown.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL
    }
}
