import SwiftUI

extension EnvironmentValues {
    @Entry public var openClawChatIsObscured: Bool = false
    @Entry public var openClawChatWrapCodeLines: Bool = false
    @Entry public var openClawChatUsesFloatingComposer = false
    @Entry public var openClawChatFloatingHeader: AnyView?
    @Entry public var openClawChatComposerAccessory: AnyView?
    @Entry public var openClawChatStatusBarInset: CGFloat = 0
    @Entry public var openClawChatInteractionsDisabled = false
    @Entry public var openClawChatDraftIdentity: AnyView?
    @Entry public var openClawChatShowsDisconnectNotice = true
    @Entry public var openClawChatNewSessionOptionsPresented: Binding<Bool>?
}

/// The transcript's visible height, between the chat header and the composer. The composer's slash panel sits
/// outside the transcript and reads it to stop below the header.
@MainActor @Observable
final class ChatTranscriptRoom {
    var height: CGFloat = 0

    struct Provider: ViewModifier {
        @State private var room = ChatTranscriptRoom()

        func body(content: Content) -> some View {
            content.environment(self.room)
        }
    }

    struct Reader: ViewModifier {
        @Environment(ChatTranscriptRoom.self) private var room: ChatTranscriptRoom?

        func body(content: Content) -> some View {
            content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { self.room?.height = $0 }
        }
    }
}

#if os(iOS)
struct ChatSafeAreaBar<Bar: View>: ViewModifier {
    var edge: VerticalEdge
    @ViewBuilder let bar: () -> Bar

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.safeAreaBar(edge: self.edge, spacing: 0, content: self.bar)
        } else {
            content.safeAreaInset(edge: self.edge, spacing: 0, content: self.bar)
        }
    }
}

extension OpenClawChatComposer {
    func focusDraft() {
        guard self.isComposerEnabled, self.interactionEnabled else { return }
        self.isFocused = true
    }
}

/// Only an explicitly requested draft takes focus, after the covering drawer finishes closing.
struct ChatNewDraftFocus: ViewModifier {
    @Environment(\.openClawChatIsObscured) private var isObscured
    let composer: OpenClawChatComposer

    func body(content: Content) -> some View {
        let model = self.composer.viewModel
        let requested = model.newChatDraft?.requestsComposerFocus == true && model.isNewChatDraft && !self.isObscured
        content.onChange(of: requested, initial: true) { _, requested in
            guard requested else { return }
            model.newChatDraft?.requestsComposerFocus = false
            self.composer.focusDraft()
        }
    }
}

struct ChatDraftIdentityPlacement: ViewModifier {
    @Environment(\.openClawChatDraftIdentity) private var identity

    func body(content: Content) -> some View {
        content.overlay {
            if let identity {
                GeometryReader { geometry in
                    let available = geometry.size.height
                    // Balance the focal point against the composer below in the actual transcript viewport.
                    let fraction = available < 250 ? 0.5 : 0.4
                    identity.position(x: geometry.size.width / 2, y: available * fraction)
                }
            }
        }
    }
}
#endif

struct ChatTranscriptNoticeInset<Banner: View>: ViewModifier {
    let error: String?
    @ViewBuilder let banner: (String) -> Banner

    func body(content: Content) -> some View {
        if let error = self.error {
            content.safeAreaInset(edge: .top, spacing: 0) { self.banner(error) }
        } else {
            content
        }
    }
}

public struct OpenClawChatDisplayOptions: OptionSet, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let reasoning = Self(rawValue: 1 << 0)
    public static let toolActivity = Self(rawValue: 1 << 1)
    public static let assistantTrace: Self = [.reasoning, .toolActivity]

    public static func assistantTrace(_ isVisible: Bool) -> Self {
        isVisible ? .assistantTrace : []
    }
}

extension OpenClawChatView {
    public enum Style {
        case standard
        case onboarding
    }

    public enum ComposerChrome {
        case full
        case clean
    }

    public struct StarterPrompt: Hashable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public let prompt: String

        public init(id: String, title: String, prompt: String) {
            self.id = id
            self.title = title
            self.prompt = prompt
        }
    }
}

func chatErrorPresentation(
    for error: String) -> (title: String, message: String, systemImage: String, tint: Color)
{
    if chatErrorIsDisconnected(error) {
        return ("Disconnected", "Reconnect to your gateway to continue.", "wifi.slash", .orange)
    }
    if error.lowercased().contains("timed out") {
        return ("Timed out", "The gateway took too long to respond.", "clock.badge.exclamationmark", .orange)
    }
    // Unknown errors: keep the raw text as the description so it stays actionable.
    return ("Something went wrong", error, "exclamationmark.triangle.fill", .orange)
}

/// The one width rule of the chat pane: a margin and a centred reading column derived from the
/// measured pane width, shared by transcript rows, cards and the composer.
struct ChatColumnLayout: Equatable {
    static let maxColumnWidth: CGFloat = 768

    let margin: CGFloat
    let columnWidth: CGFloat

    /// An unmeasured pane (width 0, before its first layout) assumes the widest column.
    init(paneWidth: CGFloat) {
        let width = paneWidth > 0 ? paneWidth : .infinity
        self.margin = width < 700 ? 16 : 24
        self.columnWidth = max(0, min(Self.maxColumnWidth, width - 2 * self.margin))
    }

    /// User bubbles and media from either speaker leave room on the opposite side of the column.
    var bubbleAndMediaMaxWidth: CGFloat {
        (self.columnWidth < 600 ? 0.82 : 0.68) * self.columnWidth
    }
}

extension EnvironmentValues {
    @Entry var openClawChatColumn = ChatColumnLayout(paneWidth: 0)
}

extension View {
    /// Centres content on the reading column. `inset` widens the frame for chrome that draws its
    /// visible surface that far inside it (the composer), so the surface itself spans the column.
    /// Padding by the margin, rather than framing to the measured column, never collapses the
    /// column while the pane is still unmeasured.
    func chatColumn(_ layout: ChatColumnLayout, inset: CGFloat = 0) -> some View {
        self.frame(maxWidth: ChatColumnLayout.maxColumnWidth + 2 * inset)
            .padding(.horizontal, layout.margin - inset)
            .frame(maxWidth: .infinity)
    }
}
