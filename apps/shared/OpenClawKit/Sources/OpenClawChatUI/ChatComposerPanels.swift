import SwiftUI

/// Connects the composer to its floating panels: reports the composer's frame, closes the panels when the
/// draft is focused or typed into, and gives focus back after a pick. A no-op off the phone.
struct ChatComposerPanelBridge: ViewModifier {
    let composer: OpenClawChatComposer
    #if os(iOS)
    @Environment(\.openClawChatComposerPanels) private var panels
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        content
            .anchorPreference(key: ChatComposerSurfaceAnchorKey.self, value: .bounds) { $0 }
            .onChange(of: self.panels?.focusRequest) { _, _ in self.composer.focusDraft() }
            .onChange(of: self.panels?.signInRequest) { _, _ in self.composer.performModelSignInAction(.open) }
            .onChange(of: self.composer.isFocused) { _, focused in
                if focused { self.panels?.dismiss() }
            }
            .onChange(of: self.composer.viewModel.input) { _, _ in
                if self.panels?.panel == .effort { self.panels?.dismiss() }
            }
        #else
        content
        #endif
    }
}

/// Closes the panels when something takes the space above the composer, such as an approval card.
struct ChatComposerPanelsYield: ViewModifier {
    #if os(iOS)
    @Environment(\.openClawChatComposerPanels) private var panels
    #endif

    func body(content: Content) -> some View {
        #if os(iOS)
        content.onGeometryChange(for: Bool.self) { $0.size.height > 0 } action: { appeared in
            if appeared { self.panels?.dismiss() }
        }
        #else
        content
        #endif
    }
}

#if os(iOS)
import UIKit

/// The floating surfaces the phone composer opens from its model and effort chips.
enum ChatComposerPanel: Equatable {
    case model
    case effort
}

/// Which panel floats over the chat, and what the composer does when it closes. One per chat view.
@MainActor
@Observable
final class ChatComposerPanelController {
    private(set) var panel: ChatComposerPanel?
    /// Bumped when the composer should take focus back, after a pick or the close button.
    private(set) var focusRequest = 0
    /// Bumped when the picker asks for the model sign-in the composer owns.
    private(set) var signInRequest = 0
    private var returnsFocus = false

    func toggle(_ panel: ChatComposerPanel, composerFocused: Bool) {
        guard self.panel != panel else {
            self.dismiss()
            return
        }
        // The picker opens with the keyboard down; the composer gets it back when the person is done.
        self.returnsFocus = panel == .model && composerFocused
        self.panel = panel
    }

    func dismiss(returningFocus: Bool = false) {
        guard self.panel != nil else { return }
        self.panel = nil
        if returningFocus, self.returnsFocus {
            self.focusRequest += 1
        }
        self.returnsFocus = false
    }

    func requestSignIn() {
        self.dismiss()
        self.signInRequest += 1
    }
}

extension EnvironmentValues {
    @Entry var openClawChatComposerPanels: ChatComposerPanelController?
}

/// The composer surface, so the panels float on its top edge and share its width.
struct ChatComposerSurfaceAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

extension View {
    /// Floats the phone composer's model picker and effort bar over this chat. `agentName` and
    /// `agentAvatar` draw the way back to the agent's own model.
    public func openClawChatComposerPanels(
        viewModel: OpenClawChatViewModel,
        agentName: String,
        agentAvatar: UIImage?) -> some View
    {
        self.modifier(ChatComposerPanelHost(
            viewModel: viewModel,
            agent: ChatModelPickerAgent(name: agentName, avatar: agentAvatar)))
    }
}

/// Hosts the composer's floating panels over the whole chat: the model picker card and the effort bar.
struct ChatComposerPanelHost: ViewModifier {
    let viewModel: OpenClawChatViewModel
    let agent: ChatModelPickerAgent

    @State private var controller = ChatComposerPanelController()
    @State private var keyboard = ChatKeyboardFrame()
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .environment(\.openClawChatComposerPanels, self.controller)
            .overlayPreferenceValue(ChatComposerSurfaceAnchorKey.self) { anchor in
                // Laid out in the safe area, but not lifted by the keyboard: the card places itself above it.
                GeometryReader { proxy in
                    if let panel = self.controller.panel, let anchor {
                        self.panels(panel, composer: proxy[anchor], proxy: proxy)
                    }
                }
                .ignoresSafeArea(.keyboard)
            }
            .animation(self.reduceMotion ? nil : .smooth(duration: 0.22), value: self.controller.panel)
            .onChange(of: self.viewModel.sessionKey) { _, _ in self.controller.dismiss() }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) {
                self.keyboard.update($0)
            }
    }

    @ViewBuilder
    private func panels(_ panel: ChatComposerPanel, composer: CGRect, proxy: GeometryProxy) -> some View {
        // Everything below is in the overlay's space; the keyboard reports screen coordinates.
        let origin = proxy.frame(in: .global).minY
        let width = proxy.size.width
        let gap = ChatComposerPanelMetrics.gap
        let screenBottom = self.keyboard.screenBottom ?? origin + proxy.size.height + proxy.safeAreaInsets.bottom
        // The overlay may start under the status bar or below it; either way the panels stay clear of it.
        let top = max(0, proxy.safeAreaInsets.top - origin) + gap
        switch panel {
        case .model:
            // One height on every screen of the picker: what fits above the keyboard, so raising it to
            // search moves the card without resizing it.
            let keyboardTop = self.keyboard.visibleTop.map { $0 - origin }
            let restingKeyboardTop = screenBottom - self.keyboard.height(screen: screenBottom) - origin
            let height = min(
                ChatComposerPanelMetrics.maxCardHeight,
                max(ChatComposerPanelMetrics.minCardHeight, restingKeyboardTop - gap - top))
            let bottom = (keyboardTop ?? composer.minY) - gap
            // Over the keyboard the composer sits under the card, so the dimming covers it too.
            self.scrim(from: -origin, to: keyboardTop == nil ? composer.minY : screenBottom - origin, width: width)
            ChatModelPickerCard(
                viewModel: self.viewModel,
                agent: self.agent,
                onPick: { self.controller.dismiss(returningFocus: true) },
                onClose: { self.controller.dismiss(returningFocus: true) },
                onSignIn: { self.controller.requestSignIn() })
                .accessibilityAction(.escape) { self.controller.dismiss(returningFocus: true) }
                .frame(width: composer.width, height: height)
                .position(x: composer.midX, y: bottom - height / 2)
                .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .bottom)))
        case .effort:
            Color.clear
                .contentShape(Rectangle())
                .frame(width: width, height: max(0, composer.minY + origin))
                .position(x: width / 2, y: (composer.minY - origin) / 2)
                .onTapGesture { self.controller.dismiss() }
                .accessibilityHidden(true)
            let room = max(0, composer.minY - gap - top)
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                ChatEffortBar(viewModel: self.viewModel)
            }
            .frame(width: composer.width, height: room)
            .position(x: composer.midX, y: top + room / 2)
            .transition(.opacity.combined(with: .offset(y: 6)))
        }
    }

    /// Dims the chat between two heights of the overlay; taps on it close the picker.
    private func scrim(from top: CGFloat, to bottom: CGFloat, width: CGFloat) -> some View {
        (self.colorScheme == .dark ? Color.black.opacity(0.42) : Color(white: 0.08).opacity(0.22))
            .frame(width: width, height: max(0, bottom - top))
            .position(x: width / 2, y: (top + bottom) / 2)
            .contentShape(Rectangle())
            // Every way of closing the picker gives the draft its keyboard back if it had it.
            .onTapGesture { self.controller.dismiss(returningFocus: true) }
            // The card has its own Close button and the VoiceOver escape gesture.
            .accessibilityHidden(true)
            .transition(.opacity)
    }
}

/// A composer chip that opens one of the panels. The picker opens with the keyboard down; the effort bar
/// leaves the draft as it is.
struct ChatComposerPanelButton<Label: View>: View {
    let panel: ChatComposerPanel
    let isFocused: Bool
    @ViewBuilder let label: () -> Label
    @Environment(\.openClawChatComposerPanels) private var panels

    var body: some View {
        Button {
            self.panels?.toggle(self.panel, composerFocused: self.isFocused)
            if self.panel == .model, self.panels?.panel == .model {
                // The draft's text view treats a false focus request as no request; end editing instead.
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil,
                    from: nil,
                    for: nil)
            }
        } label: {
            self.label()
        }
        .buttonStyle(.plain)
    }
}

/// Keeps the composer's controls showing while a panel is open, after the keyboard goes down.
struct ChatComposerPanelExpansion<Content: View>: View {
    let isFocused: Bool
    @ViewBuilder let content: (_ expanded: Bool) -> Content
    @Environment(\.openClawChatComposerPanels) private var panels

    var body: some View {
        self.content(self.isFocused || self.panels?.panel != nil)
    }
}

enum ChatComposerPanelMetrics {
    static let gap: CGFloat = 8
    static let minCardHeight: CGFloat = 280
    static let maxCardHeight: CGFloat = 560
}

/// The last software keyboard frame, in screen coordinates. The picker sizes itself for the keyboard before
/// it is up; the composer chips only show while the composer is focused, so its height is almost always known.
@MainActor
struct ChatKeyboardFrame {
    private static var lastHeight: CGFloat?
    private(set) var visibleTop: CGFloat?
    private(set) var screenBottom: CGFloat?

    mutating func update(_ notification: Notification) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              frame.height > 0
        else { return }
        // The notification comes from the keyboard's screen. Shown, the keyboard ends at its bottom; hidden,
        // it starts there. Its end frame keeps its height while it slides away, too.
        let screenBottom = (notification.object as? UIScreen)?.bounds.maxY ?? frame.maxY
        self.screenBottom = screenBottom
        self.visibleTop = frame.minY < screenBottom - 1 ? frame.minY : nil
        Self.lastHeight = frame.height
    }

    /// Before any keyboard has shown, the iPhone keyboard with its suggestion bar takes about 40% of the
    /// screen in portrait.
    func height(screen: CGFloat) -> CGFloat {
        Self.lastHeight ?? (screen * 0.4).rounded()
    }
}
#endif
