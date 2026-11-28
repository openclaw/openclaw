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
    /// The open effort bar's height, so the status strip can sit above it.
    var effortBarHeight: CGFloat = 0
    /// The status strip's surface in global coordinates, kept clear of the bar's tap-outside area.
    var statusStripFrame: CGRect?
    /// Bumped when the composer should take focus back after the picker closes.
    private(set) var focusRequest = 0
    /// The model sheet opens on Provider accounts; it holds until the sheet is gone.
    private(set) var opensAccounts = false
    private var returnsFocus = false

    func toggle(_ panel: ChatComposerPanel, composerFocused: Bool) {
        guard self.panel != panel else {
            self.dismiss()
            return
        }
        // The picker opens with the keyboard down; the composer gets it back when the sheet closes.
        self.returnsFocus = panel == .model && composerFocused
        self.opensAccounts = false
        self.panel = panel
    }

    /// Opens the effort bar on the strip's behalf ("Change" on a lowered effort).
    func openEffortBar() {
        self.returnsFocus = false
        self.panel = .effort
    }

    func dismiss() {
        self.panel = nil
    }

    /// Bumped when VoiceOver closes the effort bar, so its chip takes the VoiceOver cursor back.
    private(set) var effortChipFocusRequest = 0

    func escapeEffortBar() {
        guard self.panel == .effort else { return }
        self.dismiss()
        self.effortChipFocusRequest += 1
    }

    /// The composer's sign-in row: the model sheet, opened on Provider accounts.
    func openAccounts() {
        self.returnsFocus = false
        self.opensAccounts = true
        self.panel = .model
    }

    /// Runs once the picker sheet is gone, however it closed: the keyboard follows if it was up.
    func pickerDidDismiss() {
        if self.returnsFocus {
            self.focusRequest += 1
        }
        self.opensAccounts = false
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
    /// Presents the phone composer's model picker sheet and floats its effort bar over this chat.
    public func openClawChatComposerPanels(viewModel: OpenClawChatViewModel) -> some View {
        self.modifier(ChatComposerPanelHost(viewModel: viewModel))
    }
}

/// Hosts the composer's panels: the model picker as a system sheet and the effort bar above the composer.
struct ChatComposerPanelHost: ViewModifier {
    let viewModel: OpenClawChatViewModel

    @State private var controller = ChatComposerPanelController()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openClawToastPresenter) private var toastPresenter

    func body(content: Content) -> some View {
        content
            .environment(\.openClawChatComposerPanels, self.controller)
            .overlayPreferenceValue(ChatComposerSurfaceAnchorKey.self) { anchor in
                GeometryReader { proxy in
                    if self.controller.panel == .effort, let anchor {
                        self.effortBar(composer: proxy[anchor], proxy: proxy)
                    }
                }
                // Animate the floating bar, not the chat or its composer while the model sheet dismisses.
                .animation(self.reduceMotion ? nil : .smooth(duration: 0.22), value: self.controller.panel == .effort)
            }
            .sheet(
                isPresented: Binding(
                    get: { self.controller.panel == .model },
                    set: { if !$0, self.controller.panel == .model { self.controller.dismiss() } }),
                onDismiss: { self.controller.pickerDidDismiss() },
                content: {
                    ChatModelPickerSheet(
                        viewModel: self.viewModel,
                        opensAccounts: self.controller.opensAccounts,
                        onPick: { self.controller.dismiss() },
                        onClose: { self.controller.dismiss() })
                        .openClawSheetHeaderEdge()
                })
            .onChange(of: self.viewModel.sessionKey) { _, _ in self.controller.dismiss() }
            // A change to effort, speed or the model that didn't save says so in the app's toast.
            .onChange(of: self.viewModel.settingsChangeFailure?.id) { _, _ in
                guard let failure = self.viewModel.settingsChangeFailure else { return }
                self.toastPresenter?.post(.failure(failure.text, retry: failure.retry))
            }
    }

    @ViewBuilder
    private func effortBar(composer: CGRect, proxy: GeometryProxy) -> some View {
        let origin = proxy.frame(in: .global).minY
        let width = proxy.size.width
        let gap = ChatComposerPanelMetrics.gap
        // The overlay may start under the status bar or below it; either way the bar stays clear of it.
        let top = max(0, proxy.safeAreaInsets.top - origin) + gap
        // A tap outside the bar closes it, except on the status strip, whose action stays usable.
        let strip = self.controller.statusStripFrame.map { $0.offsetBy(dx: 0, dy: -origin) }
        ForEach(Self.tapOutsideBands(from: -origin, to: composer.minY, sparing: strip), id: \.lowerBound) { band in
            Color.clear
                .contentShape(Rectangle())
                .frame(width: width, height: band.upperBound - band.lowerBound)
                .position(x: width / 2, y: (band.lowerBound + band.upperBound) / 2)
                .onTapGesture { self.controller.dismiss() }
                .accessibilityHidden(true)
        }
        let room = max(0, composer.minY - gap - top)
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            ChatEffortBar(viewModel: self.viewModel)
                // VoiceOver's two-finger scrub closes the bar and returns to the effort chip.
                    .accessibilityAction(.escape) { self.controller.escapeEffortBar() }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                        self.controller.effortBarHeight = $0
                    }
        }
        .frame(width: composer.width, height: room)
        .position(x: composer.midX, y: top + room / 2)
        .transition(.opacity.combined(with: .offset(y: 6)))
    }

    /// The vertical bands above the composer that close the bar on a tap, leaving out the strip's row.
    static func tapOutsideBands(
        from top: CGFloat,
        to bottom: CGFloat,
        sparing strip: CGRect?) -> [ClosedRange<CGFloat>]
    {
        let bands: [(CGFloat, CGFloat)] = if let strip, strip.minY < bottom, strip.maxY > top {
            [(top, strip.minY), (strip.maxY, bottom)]
        } else {
            [(top, bottom)]
        }
        return bands.filter { $0.1 > $0.0 }.map { $0.0...$0.1 }
    }
}

/// A composer chip that opens one of the panels. The picker sheet opens with the keyboard down; the effort
/// bar leaves the draft as it is.
struct ChatComposerPanelButton<Label: View>: View {
    let panel: ChatComposerPanel
    let isFocused: Bool
    @ViewBuilder let label: () -> Label
    @Environment(\.openClawChatComposerPanels) private var panels
    @AccessibilityFocusState private var hasVoiceOverFocus: Bool

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
        .accessibilityFocused(self.$hasVoiceOverFocus)
        .onChange(of: self.panels?.effortChipFocusRequest) { _, _ in
            if self.panel == .effort { self.hasVoiceOverFocus = true }
        }
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
