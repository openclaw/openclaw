import SwiftUI

#if os(iOS)

/// The strip directly above the phone composer. It sits in the composer's dock, so it pushes the
/// transcript up instead of covering it. A status that only informs is a centered pill; one with an
/// action spans the composer's width. Both are the same height at a given text size.
struct ChatStatusStripView: View {
    let strip: OpenClawChatStatusStrip
    /// Room between the strip and what sits under it: the pills, an approval card or the composer.
    let spaceBelow: CGFloat
    @Environment(\.openClawChatComposerPanels) private var panels
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var isPerforming = false
    /// The last status shown, kept in place while a cleared strip fades out.
    @State private var lastShown: OpenClawChatStatus?

    var body: some View {
        let status = self.strip.current ?? self.lastShown
        ZStack {
            if let status {
                self.row(status)
                    // Reduce Motion swaps the two widths without resizing: the old row leaves, then the new one
                    // fades in, so no frame shows two sentences.
                        .id(self.reduceMotion ? Optional(status.isWide) : nil)
                        .transition(self.reduceMotion ? Self.swap : .opacity)
            }
        }
        .opacity(self.strip.current == nil ? 0 : 1)
        .frame(maxWidth: .infinity)
        // The effort bar floats between the strip and the composer while it is open.
        .offset(y: self.panels?.panel == .effort && status != nil
            ? -((self.panels?.effortBarHeight ?? 0) + ChatComposerPanelMetrics.gap)
            : 0)
        .padding(.bottom, status == nil ? 0 : self.spaceBelow)
        .onChange(of: self.strip.current.map(Announcement.init)) { _, announcement in
            announcement?.post()
        }
        .onChange(of: self.strip.current, initial: true) { _, current in
            guard current == nil else {
                self.lastShown = current
                return
            }
            guard self.lastShown != nil else { return }
            // A cleared strip fades in its place, then gives its row back in one step. Collapsing the row
            // inside the fade made the transcript above jump up and settle back.
            Task {
                try? await Task.sleep(for: ChatStatusStripMetrics.fadeOut)
                guard self.strip.current == nil else { return }
                withTransaction(Transaction(animation: nil)) { self.lastShown = nil }
            }
        }
    }

    private func row(_ status: OpenClawChatStatus) -> some View {
        HStack(spacing: 10) {
            ZStack {
                self.mark(status.tone)
                    .id(status.tone)
                    .transition(Self.swap)
            }
            // One sentence at a time: the old one is gone before the new one is readable, while the
            // capsule's width changes underneath.
            ZStack(alignment: .leading) {
                self.sentence(status)
                    .id(status.text)
                    .transition(Self.swap)
            }
            .font(OpenClawChatTypography.body(size: 15, weight: .medium, relativeTo: .subheadline))
            .foregroundStyle(OpenClawChatTheme.assistantText)
            // Room above and below wrapped lines; one line still fits the 44 pt the action sets.
            .padding(.vertical, 10)
            // Full width: the sentence takes the row up to the action, which keeps its own width.
            .frame(maxWidth: status.isWide ? .infinity : nil, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: status.text))
            .accessibilityAddTraits(.isStaticText)
            .accessibilityIdentifier("chat-status-strip-text")
            if let action = status.action {
                self.actionButton(action)
                    .transition(Self.swap)
            }
        }
        .padding(.leading, ChatStatusStripMetrics.inset)
        // The action's own padding finishes the edge, so its target reaches the strip's corner.
        .padding(.trailing, status.isWide ? ChatStatusStripMetrics.inset - 8 : ChatStatusStripMetrics.inset)
        .frame(minHeight: ChatStatusStripMetrics.height)
        .frame(maxWidth: status.isWide ? .infinity : nil)
        // While the capsule widens, the arriving action already sits at its final place; the capsule's own
        // edge hides it until it gets there.
        .clipShape(RoundedRectangle(cornerRadius: ChatStatusStripMetrics.radius, style: .continuous))
        .modifier(CleanChatComposerSurface(cornerRadius: ChatStatusStripMetrics.radius))
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { self.panels?.statusStripFrame = $0 }
        .onDisappear { self.panels?.statusStripFrame = nil }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-status-strip")
    }

    /// The sentence on one line when it fits. When it does not, a name inside it (a host) shortens at its
    /// tail before anything else gives way, as long as a few letters of it still show; otherwise, and at
    /// accessibility sizes, the whole sentence wraps.
    @ViewBuilder
    private func sentence(_ status: OpenClawChatStatus) -> some View {
        if let name = status.truncatable, !self.dynamicTypeSize.isAccessibilitySize,
           let range = status.text.range(of: name)
        {
            ViewThatFits(in: .horizontal) {
                Text(verbatim: status.text)
                    .lineLimit(1)
                    .fixedSize()
                HStack(spacing: 0) {
                    Text(verbatim: String(status.text[..<range.lowerBound])).fixedSize()
                    Text(verbatim: name)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        // Counts as this wide when choosing a layout, then takes the room there is.
                        .frame(idealWidth: ChatStatusStripMetrics.shortestName)
                    // The shortened name's own ellipsis ends "Reconnecting to Stud…", without a second one.
                    let rest = String(status.text[range.upperBound...])
                    if rest != "…" { Text(verbatim: rest).fixedSize() }
                }
                Text(verbatim: status.text)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else {
            Text(verbatim: status.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Out, then in: the leaving view fades in 80 ms and the arriving one starts 100 ms in, so no frame holds
    /// two legible strings.
    static let swap: AnyTransition = .asymmetric(
        insertion: .opacity.animation(.easeOut(duration: 0.16).delay(0.1)),
        removal: .opacity.animation(.easeIn(duration: 0.08)))

    private func mark(_ tone: OpenClawChatStatus.Tone) -> some View {
        ZStack {
            switch tone {
            case .progress:
                // The app's spinner in neutral ink: waiting is not an error.
                ProgressView()
                    .controlSize(.small)
                    .tint(OpenClawChatTheme.muted)
            case .info:
                Image(systemName: "info.circle")
            case .error:
                Image(systemName: "exclamationmark.circle")
            }
        }
        // The symbol takes the sentence's own size, so it scales with it.
        .font(OpenClawChatTypography.body(size: 15, weight: .medium, relativeTo: .subheadline))
        .foregroundStyle(OpenClawChatTheme.assistantText)
        .frame(minWidth: 20)
        .accessibilityHidden(true)
    }

    private func actionButton(_ action: OpenClawChatStatus.Action) -> some View {
        Button {
            guard !self.isPerforming else { return }
            self.isPerforming = true
            Task {
                await action.perform()
                self.isPerforming = false
            }
        } label: {
            // Busy keeps the label's box: the spinner takes its place, the strip does not resize.
            Text(verbatim: action.title)
                .font(OpenClawChatTypography.body(size: 15, weight: .semibold, relativeTo: .subheadline))
                .underline()
                // The action keeps its one line; the sentence wraps instead.
                .fixedSize()
                .foregroundStyle(OpenClawChatTheme.assistantText)
                .opacity(self.isPerforming ? 0 : 1)
                .overlay {
                    if self.isPerforming {
                        ProgressView()
                            .controlSize(.small)
                            .tint(OpenClawChatTheme.muted)
                    }
                }
                .padding(.horizontal, 8)
                .frame(minWidth: ChatStatusStripMetrics.height, minHeight: ChatStatusStripMetrics.height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(self.isPerforming)
        .accessibilityIdentifier("chat-status-strip-action")
    }

    /// A new strip is spoken once, without moving focus; one the person can act on interrupts.
    private struct Announcement: Equatable {
        let id: String
        let text: String
        let isUrgent: Bool

        init(_ status: OpenClawChatStatus) {
            self.id = status.id
            self.text = status.text
            self.isUrgent = status.action != nil
        }

        @MainActor
        func post() {
            var message = AttributedString(self.text)
            message.accessibilitySpeechAnnouncementPriority = self.isUrgent ? .high : .default
            AccessibilityNotification.Announcement(message).post()
        }
    }
}

enum ChatStatusStripMetrics {
    /// The action's 44 pt target is the strip's own height, so a strip with an action is no taller.
    static let height: CGFloat = 44
    static let radius: CGFloat = 22
    static let inset: CGFloat = 16
    /// With the composer's own 4 pt inset and the dock's 6 pt spacing, the strip sits 8 pt above the
    /// composer's surface, as the effort bar does.
    static let composerGap: CGFloat = -2
    /// The pills or an approval card under the strip keep the same 8 pt from it.
    static let cardGap: CGFloat = 8
    /// How long a cleared strip fades before its row closes: the strip's own animation.
    static let fadeOut: Duration = .milliseconds(260)
    /// A shortened host keeps at least this much of itself; below it the sentence wraps instead.
    static let shortestName: CGFloat = 56
}

#endif
