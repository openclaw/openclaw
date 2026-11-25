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
        let input = self.viewModel.activityInput(approvalPending: self.approvalShown, showsProgress: showsProgress)
        let pills = ChatActivityRules.pills(input)
        if !pills.isEmpty {
            ChatActivityPillRow(pills: pills) { kind in
                switch kind {
                case .subagents:
                    let working = input.children.filter(\.isWorking)
                    self.sheet = working.count == 1 ? .child(working[0].key) : .subagents
                case .goal: self.sheet = .goal
                case .progress: self.sheet = .progress
                case .pullRequest: break
                }
            }
            .chatColumn(self.column)
            .padding(.top, ChatActivityPillMetrics.dockTop)
            .padding(.bottom, ChatActivityPillMetrics.dockBottom)
        }
        self.accessory?.chatColumn(self.column).modifier(ChatComposerPanelsYield())
            .onGeometryChange(for: Bool.self) { $0.size.height > 0 } action: { self.approvalShown = $0 }
            .sheet(item: self.$sheet) { sheet in
                ChatActivitySheetView(viewModel: self.viewModel, sheet: sheet) {
                    if let signature { self.dismissedProgressCards.insert(signature) }
                }
            }
            .onChange(of: self.viewModel.sessionKey) { _, _ in self.sheet = nil }
        #else
        self.accessory?.chatColumn(self.column).modifier(ChatComposerPanelsYield())
        #endif
    }
}
