#if os(iOS)
import SwiftUI

/// What a pill opens. One sheet at a time; the subagents pill opens its only child directly.
enum ChatActivitySheet: Identifiable, Hashable {
    case goal
    case progress
    case subagents
    case child(String)

    var id: Self {
        self
    }
}

/// The row of activity pills directly above the phone composer (ui/src/pages/chat/components/chat-activity-pills.tsx).
/// It exists only while there is activity; it never wraps, and scrolls sideways when the pills outgrow it.
struct ChatActivityPillRow: View {
    let pills: [ChatActivityPill]
    let onOpen: (ChatActivityPill.Kind) -> Void
    @Environment(\.openClawChatComposerPanels) private var panels
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var fadesLeading = false
    @State private var fadesTrailing = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: ChatActivityPillMetrics.spacing) {
                ForEach(self.pills) { pill in
                    ChatActivityPillButton(pill: pill) { self.onOpen(pill.kind) }
                        .transition(.opacity)
                }
            }
            .animation(self.reduceMotion ? nil : .smooth(duration: 0.2), value: self.pills)
        }
        .scrollClipDisabled(false)
        .onScrollGeometryChange(for: [Bool].self) { geometry in
            let offset = geometry.contentOffset.x + geometry.contentInsets.leading
            return [offset > 1, offset + geometry.containerSize.width < geometry.contentSize.width - 1]
        } action: { _, edges in
            self.fadesLeading = edges[0]
            self.fadesTrailing = edges[1]
        }
        // A fade only on the side that has more pills, as the web strip does.
        .mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: self.fadesLeading ? ChatActivityPillMetrics.fade : 0)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: self.fadesTrailing ? ChatActivityPillMetrics.fade : 0)
            }
        }
        // The open effort bar floats over this band; the pills step aside until it closes.
        .opacity(self.panels?.panel == .effort ? 0 : 1)
        .allowsHitTesting(self.panels?.panel != .effort)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Chat activity"))
        .accessibilityIdentifier("chat-activity-pills")
    }
}

enum ChatActivityPillMetrics {
    static let height: CGFloat = 36
    static let spacing: CGFloat = 8
    static let fade: CGFloat = 20
    /// The pill's 36 pt face grows to a 44 pt target with this much room above and below.
    static let hitOutset: CGFloat = 4
    /// The progress pill's label stops here and fades, as the web caps it at 224 px.
    static let progressLabelWidth: CGFloat = 176
    /// The pills' faces sit 8 pt above the composer's surface, as the status strip and the effort bar do:
    /// the dock's 6 pt spacing and the composer's 4 pt inset, less the 4 pt hit outset and 2 pt.
    static let dockTop: CGFloat = 6 - hitOutset
    static let dockBottom: CGFloat = -2 - hitOutset
}

private struct ChatActivityPillButton: View {
    let pill: ChatActivityPill
    let action: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var height = ChatActivityPillMetrics.height
    @ScaledMetric(relativeTo: .subheadline) private var labelCap = ChatActivityPillMetrics.progressLabelWidth

    var body: some View {
        Button(action: self.action) {
            HStack(spacing: 8) {
                self.leadingMark
                self.label
                if let count = self.pill.count {
                    Text(verbatim: count)
                        .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .footnote))
                        .monospacedDigit()
                        .foregroundStyle(OpenClawChatTheme.muted)
                        .fixedSize()
                }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: self.height)
            .modifier(ChatActivityPillSurface())
            .padding(.vertical, ChatActivityPillMetrics.hitOutset)
            .contentShape(Rectangle())
        }
        .buttonStyle(ChatActivityPillPressStyle())
        .accessibilityLabel(Text(verbatim: self.pill.accessibilityLabel))
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(Self.identifier(self.pill.kind))
    }

    static func identifier(_ kind: ChatActivityPill.Kind) -> String {
        switch kind {
        case .subagents: "chat-activity-pill-subagents"
        case .goal: "chat-activity-pill-goal"
        case .progress: "chat-activity-pill-progress"
        case let .pullRequest(id): "chat-activity-pill-pr-\(id)"
        }
    }

    @ViewBuilder
    private var leadingMark: some View {
        if self.pill.kind == .subagents {
            // The app's own working mark, in ink: the children are working, not alarming.
            ChatWorkingClawView(seed: "activity-subagents", tint: OpenClawChatTheme.assistantText)
                .frame(width: 22, height: 20)
                .clipped()
        } else if let symbol = self.pill.symbol {
            Image(systemName: symbol)
                .font(OpenClawChatTypography.body(size: 15, weight: .medium, relativeTo: .subheadline))
                .foregroundStyle(Self.color(self.pill.labelTone == .attention ? .attention : .muted))
                .overlay(alignment: .bottomTrailing) {
                    if let badge = self.pill.badge {
                        ChatActivityBadgeMark(badge: badge)
                            .offset(x: 5, y: 4)
                    }
                }
                .padding(.trailing, self.pill.badge == nil ? 0 : 3)
                .accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private var label: some View {
        let text = Text(verbatim: self.pill.label)
            .font(OpenClawChatTypography.body(size: 15, weight: .medium, relativeTo: .subheadline))
            .foregroundStyle(Self.color(self.pill.labelTone))
            .lineLimit(1)
            .fixedSize()
        if self.pill.kind == .progress, self.pill.count != nil {
            // A step title is a label, not a sentence; past its width it fades into the pill, never "…".
            ChatActivityFadingLabel(cap: self.labelCap) { text }
        } else {
            text
        }
    }

    static func color(_ tone: ChatActivityPill.Tone) -> Color {
        switch tone {
        case .neutral: OpenClawChatTheme.assistantText
        case .muted: OpenClawChatTheme.muted
        case .attention: Color(uiColor: .systemOrange)
        case .problem: Color(uiColor: .systemRed)
        }
    }
}

/// A one-line label that keeps its natural width up to a cap and fades at the cap instead of truncating.
private struct ChatActivityFadingLabel<Content: View>: View {
    let cap: CGFloat
    @ViewBuilder let content: () -> Content
    @State private var natural: CGFloat = 0

    var body: some View {
        let overflows = self.natural > self.cap
        self.content()
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { self.natural = $0 }
            .frame(width: overflows ? self.cap : nil, alignment: .leading)
            .clipped()
            .mask {
                HStack(spacing: 0) {
                    Rectangle()
                    LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: overflows ? ChatActivityPillMetrics.fade : 0)
                }
            }
    }
}

struct ChatActivityBadgeMark: View {
    let badge: ChatActivityPill.Badge

    var body: some View {
        Group {
            switch self.badge.mark {
            case .spinner:
                ProgressView()
                    .controlSize(.mini)
                    .tint(OpenClawChatTheme.muted)
                    .scaleEffect(0.8)
            case let .symbol(name):
                Image(systemName: name)
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(ChatActivityPillButton
                        .color(self.badge.tone == .neutral ? .neutral : self.badge.tone))
            }
        }
        .frame(width: 12, height: 12)
        .background(Circle().fill(Color(uiColor: .systemBackground)))
        .accessibilityHidden(true)
    }
}

/// The composer's own surface, as a capsule: glass on iOS 26, a material before it.
private struct ChatActivityPillSurface: ViewModifier {
    func body(content: Content) -> some View {
        Group {
            if #available(iOS 26.0, *) {
                content.glassEffect(.regular.interactive(), in: .capsule)
            } else {
                content.background(.regularMaterial, in: Capsule())
            }
        }
        .overlay(Capsule().strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
    }
}

private struct ChatActivityPillPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
#endif
