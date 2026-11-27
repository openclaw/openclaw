import SwiftUI

/// The composer dock's activity, right above the approval card it also holds: the pill row when there is
/// any, and the sheet each pill opens. Order from the transcript down: pills, approval card, composer.
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
        let pills = ChatActivityRules.pills(input)
        if !pills.isEmpty {
            ChatActivityPillRow(
                pills: pills,
                sheetIsOpen: self.sheet != nil,
                onOpen: { kind in
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
                    }
                })
                .chatColumn(self.column)
                .padding(.top, ChatActivityPillMetrics.dockTop)
                .padding(.bottom, ChatActivityPillMetrics.dockBottom)
        }
        self.accessory?.chatColumn(self.column).modifier(ChatComposerPanelsYield())
            .onGeometryChange(for: Bool.self) { $0.size.height > 0 } action: { self.approvalShown = $0 }
        // The approval card can be absent, so an empty view loads the children and holds the sheet.
        Color.clear.frame(height: 0)
            .task(id: childRequest) {
                if let childRequest { await self.viewModel.loadActivityChildren(childRequest) }
            }
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
