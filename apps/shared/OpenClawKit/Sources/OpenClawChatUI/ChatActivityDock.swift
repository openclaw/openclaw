import SwiftUI

/// The composer dock's activity, right above the approval card it also holds: the pill row when there is
/// any, and the sheet each pill opens. Order from the transcript down: status strip, pills, approval card,
/// composer.
struct ChatActivityDock: View {
    let viewModel: OpenClawChatViewModel
    let accessory: AnyView?
    let column: ChatColumnLayout
    /// The chat view's local "Dismiss plan" record, shared with the old card where it still shows.
    @Binding var dismissedProgressCards: Set<String>
    #if os(iOS)
    @Environment(\.openClawOpenChildChat) private var openChildChat
    @State private var pendingChild: (key: String, name: String)?
    @State private var sheet: ChatActivitySheet?
    #endif
    /// The approval card draws nothing without an approval, so its height says whether one waits.
    @State private var approvalShown = false

    init(
        _ viewModel: OpenClawChatViewModel,
        _ accessory: AnyView?,
        _ column: ChatColumnLayout,
        _ dismissedProgressCards: Binding<Set<String>>)
    {
        self.viewModel = viewModel
        self.accessory = accessory
        self.column = column
        self._dismissedProgressCards = dismissedProgressCards
    }

    /// The Mac keeps its progress card; the phone shows the pills instead.
    static func replacesProgressCard(showsComposer: Bool) -> Bool {
        #if os(iOS)
        showsComposer
        #else
        false
        #endif
    }

    var body: some View {
        #if os(iOS)
        let signature = self.viewModel.progressCard.map { String(describing: $0) }
        let showsProgress = signature.map { !self.dismissedProgressCards.contains($0) } ?? false
        let childRequest = self.viewModel.healthOK ? self.viewModel.activityChildrenRequest : nil
        let input = self.viewModel.activityInput(approvalPending: self.approvalShown, showsProgress: showsProgress)
        let scope = self.viewModel.prVisibilityScope
        let hidden = ChatPRVisibility.shared.hidden(in: scope)
        let pills = ChatActivityRules.pills(input).filter { pill in
            if case let .pullRequest(id) = pill.kind { return !hidden.contains(id.lowercased()) }
            return true
        }
        // The connection's status strip opens the dock, above the pills and the approval card: it grows the
        // dock upward, so the pills and the card under it never move when it comes or goes. It keeps 8 pt
        // from the pills' faces (whose row starts 6 pt above them), the card, or the composer.
        ChatStatusStripView(
            strip: self.viewModel.statusStrip,
            spaceBelow: !pills.isEmpty
                ? ChatStatusStripMetrics.cardGap - ChatActivityPillMetrics.dockTop - ChatActivityPillMetrics.hitOutset
                : self.approvalShown ? ChatStatusStripMetrics.cardGap : ChatStatusStripMetrics.composerGap)
            .chatColumn(self.column)
            .onChange(of: self.viewModel.sessionKey) { _, _ in self.viewModel.statusStrip.chatDidChange() }
            .task(id: childRequest) {
                if let childRequest { await self.viewModel.loadActivityChildren(childRequest) }
            }
        if !pills.isEmpty {
            ChatActivityPillRow(
                pills: pills,
                sheetIsOpen: self.sheet != nil,
                pullRequests: self.viewModel.linkedPullRequests,
                onHide: { id in
                    ChatPRVisibility.shared.setHidden(true, ids: [id], in: scope)
                }, onOpen: { kind in
                    switch kind {
                    case .subagents:
                        // A child can be pushed from this sheet. Don't restore the parent's keyboard
                        // over its activity row after the child pops; the draft stays in the composer.
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil,
                            from: nil,
                            for: nil)
                        self.sheet = .subagents
                    case .goal: self.sheet = .goal
                    case .progress: self.sheet = .progress
                    case let .pullRequest(id): self.sheet = .pullRequest(id)
                    }
                })
                .chatColumn(self.column)
                .padding(.top, ChatActivityPillMetrics.dockTop)
                // The card has no top inset; only the composer supplies its own spacing.
                .padding(
                    .bottom,
                    self.approvalShown
                        ? ChatStatusStripMetrics.cardGap - ChatActivityPillMetrics.hitOutset
                        : ChatActivityPillMetrics.dockBottom)
        }
        self.accessory?.chatColumn(self.column).modifier(ChatComposerPanelsYield())
            .onGeometryChange(for: Bool.self) { $0.size.height > 0 } action: { self.approvalShown = $0 }
            .padding(.bottom, self.approvalShown ? ChatStatusStripMetrics.composerGap : 0)
            .sheet(item: self.$sheet, onDismiss: self.openSelectedChild) { sheet in
                ChatActivitySheetView(
                    viewModel: self.viewModel,
                    sheet: sheet,
                    onOpenChild: { key, name in
                        self.pendingChild = (key, name)
                        self.sheet = nil
                    },
                    onHideProgress: { if let signature { self.dismissedProgressCards.insert(signature) } })
                    .openClawSheetHeaderEdge()
            }
            .onChange(of: self.viewModel.sessionKey) { _, _ in self.sheet = nil }
        #else
        self.accessory?.chatColumn(self.column).modifier(ChatComposerPanelsYield())
        #endif
    }

    #if os(iOS)
    private func openSelectedChild() {
        guard let child = self.pendingChild else { return }
        self.pendingChild = nil
        if let openChildChat {
            openChildChat(child.key, child.name)
        } else {
            self.viewModel.switchSession(to: child.key)
        }
    }
    #endif
}
