import SwiftUI

extension EnvironmentValues {
    @Entry public var openClawChatIsObscured: Bool = false
}

/// Applies coverage by another surface, such as the iPhone sidebar drawer, to the model.
/// Only this modifier reads `openClawChatIsObscured`, so covering or revealing the chat
/// does not re-evaluate the transcript and composer.
struct ChatObscuredPresentation: ViewModifier {
    @Environment(\.openClawChatIsObscured) private var isObscured
    let viewModel: OpenClawChatViewModel
    let isVisible: Bool

    func body(content: Content) -> some View {
        content
            .onChange(of: ObjectIdentifier(self.viewModel)) { _, _ in
                self.viewModel.streamPacing.interval = self.isObscured ? 0.5 : 0.15
                self.viewModel.setComposerPresentationActive(self.isVisible && !self.isObscured)
            }
            // A rejected message returns to the composer only while the user can see it.
            .onChange(of: self.isVisible && !self.isObscured, initial: true) { _, active in
                self.viewModel.setComposerPresentationActive(active)
            }
            .onChange(of: self.isObscured, initial: true) { _, obscured in
                self.viewModel.streamPacing.interval = obscured ? 0.5 : 0.15
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
