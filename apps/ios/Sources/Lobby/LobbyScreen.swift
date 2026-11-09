import OpenClawChatUI
import SwiftUI

struct LobbyScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("openclaw.webchat.showAssistantTrace") private var showsAssistantTrace = true
    @Bindable var model: LobbyModel
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    @State private var showsConversation = false
    @State private var navigationRefused = false

    @State private var settingsRequest = 0
    @State private var selectedComponent: LobbyComponentSelection?

    var body: some View {
        let presentationID = self.model.presentationID
        VStack(spacing: 0) {
            if let sessionKey = self.model.sessionKey {
                SessionDashboardContent(
                    sessionKey: sessionKey,
                    agentId: self.model.ownerAgentID,
                    isLobby: true,
                    onLobbyPrompt: { text in
                        await self.model.acceptComponentPrompt(
                            text,
                            selection: self.selectedComponent,
                            presentationID: presentationID,
                            appModel: self.appModel)
                    },
                    onLobbySelection: { name in
                        guard self.model.presentationID == presentationID else { return }
                        self.selectedComponent = name
                    },
                    lobbySettingsRequest: self.settingsRequest,
                    onNavigationOutsideScope: { self.navigationRefused = true })
                    .id(self.model.presentationID)
            } else {
                self.emptyState
            }
        }
        .background(Color(uiColor: .systemBackground))
        .safeAreaInset(edge: .bottom, spacing: 0) { self.conversationFooter }
        .navigationTitle(String(localized: "Lobby"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    // Balance the decorative mark so the text stays at the navigation bar's center.
                    LobbyLobsterMark(size: 21)
                        .foregroundStyle(OpenClawBrand.accent)
                    Text("Lobby")
                        .font(OpenClawType.headline)
                    Color.clear
                        .frame(width: 21, height: 21)
                        .accessibilityHidden(true)
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
            }
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
            }
            if self.model.viewModel != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { self.settingsRequest += 1 } label: {
                        Image(systemName: "checkmark.shield")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 21, height: 21)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(String(localized: "Component access"))
                    .accessibilityIdentifier("Lobby.Access")
                }
                .sharedBackgroundVisibility(.hidden)
            }
        }
        .onAppear { self.model.sync(appModel: self.appModel) }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .active { self.model.viewModel?.resumeFromForeground() }
        }
        .onChange(of: self.model.presentationID) { _, _ in
            self.showsConversation = false
            self.selectedComponent = nil
            self.settingsRequest = 0
        }
        .sheet(isPresented: self.$showsConversation) {
            if let viewModel = self.model.conversationViewModel {
                NavigationStack {
                    OpenClawChatView(
                        viewModel: viewModel,
                        showsSessionSwitcher: false,
                        userAccent: ColorHexSupport.color(fromHex: self.appModel.gatewayAccentColorHex) ?? OpenClawBrand
                            .accent,
                        displayOptions: self.showsAssistantTrace
                            ? (viewModel.currentSessionReasoningVisible == true ? .assistantTrace : .toolActivity) : [],
                        assistantName: self.model.ownerAgentID,
                        showsAssistantAvatars: self.horizontalSizeClass != .compact,
                        composerChrome: .clean,
                        showsComposer: true)
                        .environment(\.openClawAssistantBubblesInCleanChrome, true)
                        .navigationTitle(self.model.conversationTitle)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .confirmationAction) {
                                Button { self.showsConversation = false } label: {
                                    Text("Done").font(OpenClawType.subheadSemiBold)
                                }
                            }
                        }
                }
            }
        }
        .alert(String(localized: "Open this page from navigation"), isPresented: self.$navigationRefused) {
            Button(role: .cancel) {} label: { Text("OK").font(OpenClawType.subhead) }
        }
    }

    private var emptyState: some View {
        Text("Ask your agent to create something for you here.")
            .font(OpenClawType.body)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("Lobby.Empty")
    }

    private var conversationFooter: some View {
        VStack(spacing: 8) {
            if let error = self.model.errorText {
                Text(verbatim: error).font(OpenClawType.caption)
                    .foregroundStyle(OpenClawBrand.warn)
                    .accessibilityIdentifier("Lobby.ConversationError")
            }
            HStack {
                Spacer()
                Button {
                    let selection = self.selectedComponent
                    Task {
                        if await self.model.openConversation(selection: selection, appModel: self.appModel),
                           self.selectedComponent == selection
                        {
                            self.showsConversation = true
                        }
                    }
                } label: {
                    Group {
                        if self.model.isPreparingConversation || self.model.isPreparing {
                            ProgressView()
                        } else {
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 22, weight: .regular))
                                .foregroundStyle(OpenClawBrand.accent)
                        }
                    }
                    .frame(width: 56, height: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(self.model.isPreparingConversation || self.model.isPreparing || !self.appModel
                    .isOperatorGatewayConnected)
                .accessibilityLabel(self
                    .selectedComponent == nil ? String(localized: "Lobby conversation") :
                    String(localized: "Component conversation"))
                .accessibilityIdentifier("Lobby.Conversation")
                Spacer()
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, self.selectedComponent == nil ? 22 : 6)
        .padding(.bottom, 6)
        .background(Color(uiColor: .systemBackground))
    }
}
