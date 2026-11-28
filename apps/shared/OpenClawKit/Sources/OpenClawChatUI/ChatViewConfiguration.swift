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
