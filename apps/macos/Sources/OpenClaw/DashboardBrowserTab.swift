import AppKit
import Foundation
import QuartzCore
import WebKit

@MainActor
final class DashboardBrowserTab: NSView, @MainActor NSTextFinderBarContainer {
    /// WebKit preserves one WKNavigation identity across a redirect chain.
    /// A different identity means the opened-link alias is no longer current.
    private enum RequestAliasPhase {
        case awaitingNavigation
        case loading(AnyObject)
        case retained
        case retired
    }

    /// Content-process exits recovered by automatic reload since the user last navigated.
    /// Finished loads do not restore it: a page that crashes after each reload would loop.
    static let automaticReloadLimit = 2

    let webView: WKWebView
    private let finder = NSTextFinder()
    private let visibilityMask = CAShapeLayer()
    private var holes: CGPath?
    let requestedURL: URL
    var representedURL: URL?
    var title: String?
    var favicon: String?
    var faviconGeneration: UInt64 = 0
    var faviconRefreshPending = false
    var navigationWasUserActivated = false
    var observations: [NSKeyValueObservation] = []
    /// WebKit's reload replays the last committed item, which a failed first load never
    /// created, so a shown failure keeps the URL that Reload retries.
    private(set) var failedURL: URL?
    private(set) var failureView: DashboardBrowserFailureView?
    private var automaticReloads = 0
    private var requestAliasPhase: RequestAliasPhase = .awaitingNavigation
    private var pendingNavigation: (navigation: WKNavigation, stop: Bool)?

    init(websiteDataStore: WKWebsiteDataStore, requestedURL: URL) {
        // Reading tabs share browser sessions, never the dashboard's privileged
        // scripts, auth injection, or message handlers.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStore
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.tabFocusesLinks = true
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        self.webView.setValue(true, forKey: "drawsBackground")
        self.requestedURL = requestedURL
        self.representedURL = requestedURL
        super.init(frame: .zero)
        self.wantsLayer = true
        self.webView.autoresizingMask = [.width, .height]
        self.addSubview(self.webView)
        self.finder.client = self.webView
        self.finder.findBarContainer = self
        self.finder.isIncrementalSearchingEnabled = true
        self.finder.incrementalSearchingShouldDimContentView = false
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    var findBarView: NSView?
    var isFindBarVisible = false {
        didSet {
            guard oldValue != self.isFindBarVisible, let bar = self.findBarView else { return }
            if self.isFindBarVisible {
                bar.autoresizingMask = [.width, .minYMargin]
                self.addSubview(bar)
            } else {
                bar.removeFromSuperview()
                if !self.isHiddenOrHasHiddenAncestor { self.window?.makeFirstResponder(self.webView) }
            }
            self.findBarViewDidChangeHeight()
        }
    }

    func findBarViewDidChangeHeight() {
        // Keep even a match on the first line visible: the bar is a sibling, not a page overlay.
        let bar = self.isFindBarVisible ? self.findBarView : nil
        let height = bar?.frame.height ?? 0
        let width = self.bounds.width
        let pageHeight = max(0, self.bounds.height - height)
        bar?.frame = NSRect(x: 0, y: pageHeight, width: width, height: height)
        self.webView.frame = NSRect(x: 0, y: 0, width: width, height: pageHeight)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let key = modifiers == .command ? event.characters : event.charactersIgnoringModifiers
        guard event.type == .keyDown, modifiers == .command || modifiers == .control, key?.lowercased() == "f",
              self.failureView == nil, !self.isHiddenOrHasHiddenAncestor,
              let responder = self.window?.firstResponder as? NSView,
              responder.isDescendant(of: self)
        else { return super.performKeyEquivalent(with: event) }
        self.finder.performAction(.showFindInterface)
        return true
    }

    /// Paint and hit-test the same holes so toast actions go to the dashboard, not the webpage.
    func applyCutouts(_ cutouts: [DashboardBrowserCutout], dashboardFrame: CGRect) {
        let holes = CGMutablePath()
        for cutout in cutouts {
            let rect = cutout.rect
            let local = CGRect(
                x: dashboardFrame.minX + rect.x - self.frame.minX,
                y: dashboardFrame.maxY - rect.y - rect.height - self.frame.minY,
                width: rect.width,
                height: rect.height)
            guard local.intersects(self.bounds) else { continue }
            if cutout.radius == 0 {
                holes.addRect(local)
            } else {
                holes.addRoundedRect(in: local, cornerWidth: cutout.radius, cornerHeight: cutout.radius)
            }
        }
        if holes.isEmpty {
            self.holes = nil
            self.layer?.mask = nil
            return
        }
        self.holes = holes
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        self.visibilityMask.frame = self.bounds
        // Subtract the union: overlapping toast cards still form one hole.
        self.visibilityMask.path = CGPath(rect: self.bounds, transform: nil).subtracting(holes)
        self.layer?.mask = self.visibilityMask
        CATransaction.commit()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        if self.holes?.contains(self.convert(point, from: self.superview)) == true {
            return nil
        }
        // This wrapper must never claim clicks itself, including on a hidden tab.
        let hit = super.hitTest(point)
        return hit === self ? nil : hit
    }

    var requestedURLAlias: URL? {
        if case .retired = self.requestAliasPhase {
            nil
        } else {
            self.requestedURL
        }
    }

    func trackNavigation(_ navigation: WKNavigation?) {
        guard let navigation else { return }
        self.pendingNavigation = self.webView.isLoading ? (navigation, false) : nil
    }

    func stopLoading() {
        // Stopping before WebKit starts the navigation can strand its loading state.
        // Keep the request's identity and stop it at the provisional-start callback.
        if self.pendingNavigation != nil {
            self.pendingNavigation?.stop = true
        } else {
            self.webView.stopLoading()
        }
    }

    private func retirePendingNavigation(_ navigation: AnyObject?) -> Bool {
        guard let pending = self.pendingNavigation, pending.navigation === navigation else { return false }
        self.pendingNavigation = nil
        return pending.stop
    }

    func startNavigation(_ navigation: AnyObject) {
        if self.retirePendingNavigation(navigation) { self.webView.stopLoading() }
        switch self.requestAliasPhase {
        case .awaitingNavigation:
            self.requestAliasPhase = .loading(navigation)
        case let .loading(initial) where initial !== navigation:
            self.requestAliasPhase = .retired
        case .retained:
            self.requestAliasPhase = .retired
        case .loading, .retired:
            break
        }
    }

    func updateRepresentedURL(_ url: URL?) {
        // Initial redirects keep the opened link reusable. Once that chain
        // finishes, a distinct navigation retires the now-stale alias.
        if case .retained = self.requestAliasPhase, let url, url != self.representedURL {
            self.requestAliasPhase = .retired
        }
        self.representedURL = url
    }

    func finishNavigation(_ navigation: AnyObject?, at url: URL?, title: String?) {
        _ = self.retirePendingNavigation(navigation)
        self.updateRepresentedURL(url)
        self.title = title
        guard let navigation else { return }
        switch self.requestAliasPhase {
        case .awaitingNavigation:
            self.requestAliasPhase = .retained
        case let .loading(initial) where initial === navigation:
            self.requestAliasPhase = .retained
        case .loading:
            self.requestAliasPhase = .retired
        case .retained, .retired:
            break
        }
    }

    func failNavigation(_ navigation: AnyObject?) {
        _ = self.retirePendingNavigation(navigation)
        // A failed initial chain has no reusable page. Retire its alias so
        // opening the original link again starts a fresh load.
        self.requestAliasPhase = .retired
    }

    /// Covers the blank or previous page with native text that page script cannot reach.
    func showFailure(at url: URL, title: String, message: String, reload: @escaping @MainActor () -> Void) {
        if self.isFindBarVisible { self.finder.performAction(.hideFindInterface) }
        self.failureView?.removeFromSuperview()
        let view = DashboardBrowserFailureView(title: title, message: message, reload: reload)
        view.frame = self.webView.bounds
        view.autoresizingMask = [.width, .height]
        self.webView.addSubview(view)
        self.failedURL = url
        self.failureView = view
    }

    func clearFailure() {
        self.failureView?.removeFromSuperview()
        self.failureView = nil
        self.failedURL = nil
    }

    /// Returns whether a content-process exit may reload automatically.
    func consumeAutomaticReload() -> Bool {
        guard self.automaticReloads < Self.automaticReloadLimit else { return false }
        self.automaticReloads += 1
        return true
    }

    func resetAutomaticReloads() {
        self.automaticReloads = 0
    }

    func observeNavigationState(onChange: @escaping @MainActor () -> Void) {
        // KVO catches late WebKit updates and same-document SPA navigation.
        self.observations = [\WKWebView.canGoBack, \.canGoForward, \.isLoading].map { keyPath in
            self.webView.observe(keyPath, options: [.new]) { [weak self] webView, _ in
                // Same-document loads finish through KVO, without navigation delegates.
                // WebKit notifies on the main thread; retire before another page action.
                MainActor.assumeIsolated {
                    if !webView.isLoading { self?.pendingNavigation = nil }
                }
                Task { @MainActor in onChange() }
            }
        } + [
            self.webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.updateRepresentedURL(self.webView.url)
                    onChange()
                }
            },
            self.webView.observe(\.title, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.title = self.webView.title
                    onChange()
                }
            },
        ]
    }

    func dispose() {
        self.observations.forEach { $0.invalidate() }
        self.observations.removeAll()
        self.clearFailure()
        self.webView.navigationDelegate = nil
        self.webView.uiDelegate = nil
        self.finder.client = nil
        self.finder.findBarContainer = nil
        self.webView.stopLoading()
        self.webView.removeFromSuperview()
        self.removeFromSuperview()
    }
}

/// Native failure state for a reading tab. It is not part of the page, so the
/// untrusted document can neither restyle it nor reach the Reload action.
@MainActor
final class DashboardBrowserFailureView: NSView {
    let titleLabel: NSTextField
    let messageLabel: NSTextField
    let reloadButton: NSButton
    private let reload: @MainActor () -> Void

    init(title: String, message: String, reload: @escaping @MainActor () -> Void) {
        self.titleLabel = NSTextField(labelWithString: title)
        self.messageLabel = NSTextField(wrappingLabelWithString: message)
        self.reloadButton = NSButton(title: String(localized: "Reload"), target: nil, action: nil)
        self.reload = reload
        super.init(frame: .zero)
        // Layer-backed like its WKWebView host: as a plain view it drew its opaque
        // background over the whole dashboard window, not just the tab.
        self.wantsLayer = true
        self.titleLabel.font = .systemFont(ofSize: NSFont.systemFontSize + 4, weight: .semibold)
        self.titleLabel.alignment = .center
        self.messageLabel.textColor = .secondaryLabelColor
        self.messageLabel.alignment = .center
        self.messageLabel.preferredMaxLayoutWidth = 360
        self.reloadButton.target = self
        self.reloadButton.action = #selector(self.reloadPage)
        self.reloadButton.bezelStyle = .push
        let stack = NSStackView(views: [self.titleLabel, self.messageLabel, self.reloadButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(16, after: self.messageLabel)
        stack.translatesAutoresizingMaskIntoConstraints = false
        self.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: self.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: self.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: self.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: self.trailingAnchor, constant: -24),
        ])
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isOpaque: Bool {
        true
    }

    override var wantsUpdateLayer: Bool {
        true
    }

    override func updateLayer() {
        // Runs with the view's appearance current, so the dynamic color resolves.
        self.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    @objc private func reloadPage() {
        self.reload()
    }
}
