#if os(iOS)
import SwiftUI

/// Each activity pill opens its own sheet.
enum ChatActivitySheet: Identifiable, Hashable {
    case goal
    case progress
    case subagents
    case pullRequest(String)

    var id: Self {
        self
    }
}

/// The row of activity pills directly above the phone composer (ui/src/pages/chat/components/chat-activity-pills.tsx).
/// It exists only while there is activity; it never wraps, and scrolls sideways when the pills outgrow it.
struct ChatActivityPillRow: View {
    let pills: [ChatActivityPill]
    let sheetIsOpen: Bool
    var pullRequests: [ChatActivityPullRequest] = []
    var onHide: (String) -> Void = { _ in }
    @Environment(\.openURL) private var openURL
    let onOpen: (ChatActivityPill.Kind) -> Void
    @Environment(\.openClawChatComposerPanels) private var panels
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var fadesLeading = false
    @State private var fadesTrailing = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: ChatActivityPillMetrics.spacing) {
                ForEach(self.pills) { pill in
                    let button = ChatActivityPillButton(
                        pill: pill,
                        canWave: !self.sheetIsOpen && self.panels?.panel == nil) { self.onOpen(pill.kind) }
                            .transition(.opacity)
                    if case let .pullRequest(id) = pill.kind, let pr = self.pullRequests.first(where: { $0.id == id }) {
                        button.contextMenu {
                            Button { self.onHide(id) } label: {
                                Label("Hide", systemImage: "eye.slash")
                            }
                            if let url = URL(string: pr.url) {
                                Button { self.openURL(url) } label: {
                                    Label("Open on GitHub", systemImage: "arrow.up.right.square")
                                }
                            }
                        }.tint(.primary)
                    } else { button }
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
    /// A little fuller than the web's 36 px pill, as Victor asked; it grows with Dynamic Type and never
    /// shrinks below `minimumHeight`, so smaller text sizes keep a full pill.
    static let height: CGFloat = 40
    static let minimumHeight: CGFloat = 38
    static let spacing: CGFloat = 8
    static let fade: CGFloat = 20
    /// The smallest face, 38 pt, grows to a 44 pt target with this much room above and below.
    static let hitOutset: CGFloat = 3
    /// The progress pill's label stops here and fades, as the web caps it at 224 px.
    static let progressLabelWidth: CGFloat = 176
    /// The pills' faces sit 8 pt above the composer's surface, as the status strip and the effort bar do:
    /// the dock's 6 pt spacing and the composer's 4 pt inset, less the 4 pt hit outset and 2 pt.
    static let dockTop: CGFloat = 6 - hitOutset
    static let dockBottom: CGFloat = -2 - hitOutset
}

private struct ChatActivityPillButton: View {
    let pill: ChatActivityPill
    let canWave: Bool
    let action: () -> Void
    @ScaledMetric(relativeTo: .subheadline) private var height = ChatActivityPillMetrics.height
    @ScaledMetric(relativeTo: .subheadline) private var labelCap = ChatActivityPillMetrics.progressLabelWidth

    var body: some View {
        Button(action: self.action) {
            Group {
                if case .pullRequest = self.pill.kind {
                    ChatPullRequestPillFace(pill: self.pill)
                } else {
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
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: max(ChatActivityPillMetrics.minimumHeight, self.height))
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
        if !self.pill.avatarKeys.isEmpty {
            ChatSubagentAvatarStack(keys: self.pill.avatarKeys, canWave: self.canWave)
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
            .lineLimit(1)
            .fixedSize()
        if self.pill.shimmers {
            text.chatTextShimmer(true)
        } else if self.pill.kind == .progress, self.pill.count != nil {
            let text = text.foregroundStyle(Self.color(self.pill.labelTone))
            // A step title is a label, not a sentence; past its width it fades into the pill, never "…".
            ChatActivityFadingLabel(cap: self.labelCap) { text }
        } else {
            text.foregroundStyle(Self.color(self.pill.labelTone))
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
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular.interactive(), in: .capsule)
        } else {
            content
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
    }
}

private struct ChatActivityPillPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
#endif
