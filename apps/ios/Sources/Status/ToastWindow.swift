import OpenClawChatUI
import SwiftUI
import UIKit

/// The toast sits in its own window, one level above the app's. A sheet is presented inside the
/// app's window, so anything drawn in that window (the old root overlays) is covered by it; a window
/// above is not. Touches outside the capsule fall through to the app.
///
/// The window starts below the status bar so the app's own window keeps deciding the status bar style.
final class ToastPassthroughWindow: UIWindow {
    /// The capsule's frame in this window's coordinates; touches anywhere else pass through.
    var interactiveFrame: CGRect = .null

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard self.interactiveFrame.contains(point) else { return nil }
        return super.hitTest(point, with: event)
    }
}

/// Where the capsule goes: 10 pt under the chat's top bar. The chat reports where its bar ends
/// (the main chat's bar is taller, with the agent's name under the avatar); elsewhere the capsule
/// sits where a one-row top bar ends.
@MainActor
@Observable
final class ToastPlacement {
    static let defaultTopBarHeight: CGFloat = 52
    static let gapBelowTopBar: CGFloat = 10

    /// Bottom of the chat's top bar in screen points, while a chat is on screen.
    var topBarBottom: CGFloat?
    /// Top of the toast window in screen points (the bottom of the status bar area).
    var windowTop: CGFloat = 0

    var capsuleTop: CGFloat {
        let barBottom = self.topBarBottom ?? self.windowTop + Self.defaultTopBarHeight
        return max(0, barBottom - self.windowTop) + Self.gapBelowTopBar
    }
}

@MainActor
final class ToastWindowController {
    let placement = ToastPlacement()
    private var window: ToastPassthroughWindow?
    private weak var appWindow: UIWindow?
    /// The app's resolved appearance, including its own Light/Dark setting.
    var colorScheme: ColorScheme = .light {
        didSet { self.layout() }
    }

    func install(over appWindow: UIWindow, presenter: OpenClawToastPresenter) {
        guard self.window == nil || self.appWindow !== appWindow, let scene = appWindow.windowScene else {
            self.layout()
            return
        }
        self.appWindow = appWindow
        let window = ToastPassthroughWindow(windowScene: scene)
        window.windowLevel = .normal + 1
        window.backgroundColor = .clear
        let host = UIHostingController(rootView: ToastLayer(
            presenter: presenter,
            placement: self.placement,
            onInteractiveFrameChange: { [weak window] frame in window?.interactiveFrame = frame })
            .ignoresSafeArea())
        host.view.backgroundColor = .clear
        window.rootViewController = host
        window.isHidden = false
        self.window = window
        self.layout()
    }

    /// Follows the app window's size, safe area and appearance.
    func layout() {
        guard let window, let appWindow else { return }
        let top = appWindow.safeAreaInsets.top
        self.placement.windowTop = top
        let frame = CGRect(x: 0, y: top, width: appWindow.bounds.width, height: appWindow.bounds.height - top)
        if window.frame != frame { window.frame = frame }
        window.overrideUserInterfaceStyle = self.colorScheme == .dark ? .dark : .light
    }
}

private struct ToastWindowHost: ViewModifier {
    let presenter: OpenClawToastPresenter
    @Environment(\.colorScheme) private var colorScheme
    @State private var controller = ToastWindowController()

    func body(content: Content) -> some View {
        content
            .environment(self.controller.placement)
            .background(ToastAppWindowReader { window in
                self.controller.install(over: window, presenter: self.presenter)
            })
            .onGeometryChange(for: CGSize.self) { $0.size } action: { _ in self.controller.layout() }
            .onChange(of: self.colorScheme, initial: true) { self.controller.colorScheme = self.colorScheme }
    }
}

/// Hands over the app's window once this view is in it.
private struct ToastAppWindowReader: UIViewRepresentable {
    let onWindow: (UIWindow) -> Void

    func makeUIView(context _: Context) -> ReaderView {
        let view = ReaderView()
        view.onWindow = self.onWindow
        return view
    }

    func updateUIView(_ view: ReaderView, context _: Context) {
        view.onWindow = self.onWindow
    }

    final class ReaderView: UIView {
        var onWindow: ((UIWindow) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let window else { return }
            // The window's traits settle after the first layout pass.
            DispatchQueue.main.async { [weak self] in self?.onWindow?(window) }
        }
    }
}

/// Reports the bottom of the view it's attached to as the top bar the toast sits under.
private struct ToastTopBarReporter: ViewModifier {
    @Environment(ToastPlacement.self) private var placement: ToastPlacement?

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { bottom in
                self.placement?.topBarBottom = bottom
            }
            .onDisappear { self.placement?.topBarBottom = nil }
    }
}

extension View {
    /// Marks this view as the top bar the toast sits under.
    func toastTopBar() -> some View {
        self.modifier(ToastTopBarReporter())
    }

    /// Installs the app's one toast window and lets every view below post to it.
    func openClawToasts(_ presenter: OpenClawToastPresenter) -> some View {
        self
            .environment(\.openClawToastPresenter, presenter)
            .modifier(ToastWindowHost(presenter: presenter))
    }
}
