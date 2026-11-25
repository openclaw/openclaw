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

/// Which panel is open over the chat, and what the composer does when it closes. One per chat view.
@MainActor
@Observable
final class ChatComposerPanelController {
    private(set) var panel: ChatComposerPanel?
    /// Bumped when the composer should take focus back after the picker closes.
    private(set) var focusRequest = 0
    /// Bumped when the picker asks for the model sign-in the composer owns.
    private(set) var signInRequest = 0
    private var returnsFocus = false
    private var opensSignIn = false

    func toggle(_ panel: ChatComposerPanel, composerFocused: Bool) {
        guard self.panel != panel else {
            self.dismiss()
            return
        }
        // The picker opens with the keyboard down; the composer gets it back when the sheet closes.
        self.returnsFocus = panel == .model && composerFocused
        self.panel = panel
    }

    func dismiss() {
        self.panel = nil
    }

    func requestSignIn() {
        self.opensSignIn = true
        self.dismiss()
    }

    /// Runs once the picker sheet is gone, however it closed: the sign-in sheet or the keyboard follows.
    func pickerDidDismiss() {
        if self.opensSignIn {
            self.signInRequest += 1
        } else if self.returnsFocus {
            self.focusRequest += 1
        }
        self.opensSignIn = false
        self.returnsFocus = false
    }
}

extension EnvironmentValues {
    @Entry var openClawChatComposerPanels: ChatComposerPanelController?
}

/// The composer surface, so the effort bar floats on its top edge and shares its width.
struct ChatComposerSurfaceAnchorKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil

    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

extension View {
    /// Presents the phone composer's model picker sheet and floats its effort bar over this chat. `agentName` and
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

/// Hosts the composer's panels: the model picker as a system sheet and the effort bar above the composer.
struct ChatComposerPanelHost: ViewModifier {
    let viewModel: OpenClawChatViewModel
    let agent: ChatModelPickerAgent

    @State private var controller = ChatComposerPanelController()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .environment(\.openClawChatComposerPanels, self.controller)
            .overlayPreferenceValue(ChatComposerSurfaceAnchorKey.self) { anchor in
                GeometryReader { proxy in
                    if self.controller.panel == .effort, let anchor {
                        self.effortBar(composer: proxy[anchor], proxy: proxy)
                    }
                }
            }
            .animation(self.reduceMotion ? nil : .smooth(duration: 0.22), value: self.controller.panel)
            .sheet(
                isPresented: Binding(
                    get: { self.controller.panel == .model },
                    set: { if !$0, self.controller.panel == .model { self.controller.dismiss() } }),
                onDismiss: { self.controller.pickerDidDismiss() },
                content: {
                    ChatModelPickerSheet(
                        viewModel: self.viewModel,
                        agent: self.agent,
                        onPick: { self.controller.dismiss() },
                        onClose: { self.controller.dismiss() },
                        onSignIn: { self.controller.requestSignIn() })
                })
            .onChange(of: self.viewModel.sessionKey) { _, _ in self.controller.dismiss() }
    }

    @ViewBuilder
    private func effortBar(composer: CGRect, proxy: GeometryProxy) -> some View {
        let origin = proxy.frame(in: .global).minY
        let width = proxy.size.width
        let gap = ChatComposerPanelMetrics.gap
        // The overlay may start under the status bar or below it; either way the bar stays clear of it.
        let top = max(0, proxy.safeAreaInsets.top - origin) + gap
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

/// A composer chip that opens one of the panels. The picker sheet opens with the keyboard down; the effort
/// bar leaves the draft as it is.
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
}
#endif
