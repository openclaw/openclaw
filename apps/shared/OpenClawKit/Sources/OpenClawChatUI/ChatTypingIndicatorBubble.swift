import SwiftUI

@MainActor
struct ChatTypingIndicatorBubble: View {
    @Environment(\.openClawAssistantRunContent) private var isRunContent
    private var column = ChatTranscriptIconColumn()
    let showsAssistantAvatar: Bool
    let runIdentity: String
    #if os(iOS)
    /// The run's phase, or “Thinking” after output that is not answer text; nil shows the claw alone.
    let status: String?
    // Move the existing space below the live list cell inside its control, keeping the ink in place.
    static let inspectionPadding: CGFloat = 10
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hold = ChatWorkingLabelHold()
    @State private var opacity = 1.0
    var toolLabel: String?
    var openTools: (() -> Void)?

    private struct Change: Equatable {
        let label: String?
        let reduced: Bool
    }
    #else
    @State private var startedAt = Date()
    let outputTokens: Int?
    let status: String?
    #endif

    var body: some View {
        #if os(iOS)
        Group {
            if let openTools {
                Button(action: openTools) {
                    self.row
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.bottom, Self.inspectionPadding)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: self.accessibleStatus))
                .accessibilityIdentifier("chat-working-status")
            } else {
                self.row
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, Self.inspectionPadding)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(verbatim: self.accessibleStatus))
                    .accessibilityIdentifier("chat-working-status")
            }
        }
        .task(id: Change(label: self.label, reduced: self.reduceMotion)) { await self.swapLabel() }
        #else
        self.row
            .frame(maxWidth: .infinity, alignment: .leading)
            .focusable(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: self.accessibleStatus))
        #endif
    }

    private var accessibleStatus: String {
        #if os(iOS)
        self.hold.shown ?? String(localized: "Working")
        #else
        self.status ?? String(localized: "Writing")
        #endif
    }

    private var row: some View {
        HStack(spacing: 8) {
            if self.showsAssistantAvatar, !self.isRunContent { ChatAssistantAvatar(size: 28) }
            HStack(spacing: self.column.spacing) {
                #if os(iOS)
                ChatWorkingClawView(seed: self.runIdentity, artworkSize: 20)
                    .frame(width: self.column.width)
                ZStack(alignment: .leading) {
                    // Keep the line's height while it shows the claw alone.
                    Text(verbatim: " ").hidden()
                    Text(verbatim: self.visibleStatus)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                // One style in every state, the transcript's reading size, as the tool rows beside it.
                .font(OpenClawChatTypography.transcriptBody)
                .modifier(ChatTextShimmer(
                    active: !self.reduceMotion,
                    base: Color(uiColor: .secondaryLabel),
                    highlight: self.reduceMotion ? Color(uiColor: .secondaryLabel) : OpenClawChatTheme.assistantText))
                .opacity(self.opacity)
                #else
                ChatWorkingClawView(seed: self.runIdentity).frame(width: self.column.width)
                self.ordinaryStatus.foregroundStyle(.secondary)
                #endif
            }
            .padding(.vertical, 5)
        }
    }

    #if os(iOS)
    /// A running tool names the step; otherwise the run's phase or “Thinking”.
    var label: String? {
        self.toolLabel ?? self.status
    }

    var visibleStatus: String {
        self.hold.shown ?? ""
    }
    #else
    private var ordinaryStatus: some View {
        ChatWorkingStatusText(
            startedAt: self.startedAt,
            seed: self.runIdentity,
            outputTokens: self.outputTokens,
            status: self.status)
    }
    #endif

    #if os(iOS)
    private func swapLabel() async {
        if self.reduceMotion {
            var transaction = Transaction(animation: nil)
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                self.hold = ChatWorkingLabelHold(shown: self.label)
                self.opacity = 1
            }
            return
        }
        guard self.hold.shown != self.label else {
            withAnimation(.easeOut(duration: 0.105)) { self.opacity = 1 }
            return
        }
        // Each new event cancels the previous task: only the newest label waits out the hold, so the
        // phases or calls that pass meanwhile are skipped, never flashed. The sheet still lists every call.
        do {
            try await Task.sleep(until: self.hold.until, clock: .continuous)
            try Task.checkCancellation()
            withAnimation(.easeIn(duration: 0.075)) { self.opacity = 0 }
            try await Task.sleep(for: .milliseconds(75))
            self.hold.show(self.label, isTool: self.toolLabel != nil, at: .now)
            withAnimation(.easeOut(duration: 0.105)) { self.opacity = 1 }
        } catch {}
    }
    #endif
}

#if os(iOS)
/// The working line's label on screen and how long it holds. A label stays at least 0.4 s (a tool's
/// title 0.6 s) so a phase that passes faster is skipped instead of flashed.
struct ChatWorkingLabelHold: Equatable {
    private(set) var shown: String?
    private(set) var until = ContinuousClock.now

    init(shown: String? = nil) {
        self.shown = shown
    }

    /// Shows `label` once the label on screen has held its time; otherwise keeps it and returns false.
    @discardableResult
    mutating func show(_ label: String?, isTool: Bool, at now: ContinuousClock.Instant) -> Bool {
        guard now >= self.until else { return false }
        if label != self.shown, label != nil {
            self.until = now.advanced(by: .milliseconds(isTool ? 600 : 400))
        }
        self.shown = label
        return true
    }
}
#endif
