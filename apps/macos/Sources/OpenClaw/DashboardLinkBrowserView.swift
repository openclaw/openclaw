import AppKit
import Foundation
import WebKit

@MainActor
final class DashboardLinkBrowserView: NSView {
    let webView: WKWebView
    var onClose: (() -> Void)?
    var onOpenExternal: ((URL) -> Void)?

    private let backButton = DashboardLinkBrowserView.makeButton(symbol: "chevron.left", label: "Back")
    private let forwardButton = DashboardLinkBrowserView.makeButton(symbol: "chevron.right", label: "Forward")
    private let reloadButton = DashboardLinkBrowserView.makeButton(symbol: "arrow.clockwise", label: "Reload")
    private let externalButton = DashboardLinkBrowserView.makeButton(
        symbol: "arrow.up.right.square",
        label: "Open in Default Browser"
    )
    private let closeButton = DashboardLinkBrowserView.makeButton(symbol: "xmark", label: "Close Sidebar")
    private var navigationObservations: [NSKeyValueObservation] = []
    private var representedURL: URL?
    private let addressLabel: NSTextField = {
        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }()

    init(websiteDataStore: WKWebsiteDataStore) {
        // External pages share persisted browser sessions, but never inherit the
        // dashboard's auth scripts or privileged message handler.
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = websiteDataStore
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(frame: .zero)

        webView.setValue(true, forKey: "drawsBackground")
        configureActions()
        buildView()
        observeNavigationState()
        updateChrome()
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func open(_ url: URL) {
        navigationWillStart(url)
        webView.load(URLRequest(url: url))
    }

    func closeBrowser() {
        webView.stopLoading()
        representedURL = nil
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        updateChrome()
    }

    func updateChrome() {
        let url = representedURL
        addressLabel.stringValue = url?.host(percentEncoded: false) ?? url?.absoluteString ?? ""
        addressLabel.toolTip = url?.absoluteString
        backButton.isEnabled = webView.canGoBack
        forwardButton.isEnabled = webView.canGoForward
        reloadButton.isEnabled = url != nil
        externalButton.isEnabled = url.flatMap(Self.httpURL) != nil
    }

    func navigationWillStart(_ url: URL) {
        representedURL = url
        updateChrome()
    }

    func navigationDidFinish() {
        representedURL = webView.url
        updateChrome()
    }

    private func configureActions() {
        backButton.target = self
        backButton.action = #selector(goBack)
        forwardButton.target = self
        forwardButton.action = #selector(goForward)
        reloadButton.target = self
        reloadButton.action = #selector(reload)
        externalButton.target = self
        externalButton.action = #selector(openExternal)
        closeButton.target = self
        closeButton.action = #selector(close)
    }

    private func observeNavigationState() {
        // WebKit updates these properties after some navigation delegate callbacks.
        // KVO also catches same-document SPA URL changes that skip didFinish.
        navigationObservations = [
            webView.observe(\.canGoBack, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.updateChrome()
                }
            },
            webView.observe(\.canGoForward, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.updateChrome()
                }
            },
            webView.observe(\.url, options: [.new]) { [weak self] _, _ in
                Task { @MainActor in
                    self?.navigationDidFinish()
                }
            },
        ]
    }

    private func buildView() {
        let toolbar = NSVisualEffectView()
        toolbar.material = .headerView
        toolbar.blendingMode = .withinWindow
        toolbar.state = .active
        toolbar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(toolbar)

        let controls = NSStackView(views: [
            backButton,
            forwardButton,
            reloadButton,
            addressLabel,
            externalButton,
            closeButton,
        ])
        controls.orientation = .horizontal
        controls.alignment = .centerY
        controls.distribution = .fill
        controls.spacing = 4
        controls.setCustomSpacing(10, after: reloadButton)
        controls.setCustomSpacing(10, after: addressLabel)
        controls.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(controls)

        let separator = NSBox()
        separator.boxType = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        toolbar.addSubview(separator)

        webView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(webView)

        NSLayoutConstraint.activate([
            toolbar.leadingAnchor.constraint(equalTo: leadingAnchor),
            toolbar.trailingAnchor.constraint(equalTo: trailingAnchor),
            toolbar.topAnchor.constraint(equalTo: topAnchor),
            // The top 32 points stay clear of the dashboard window's drag overlay.
            toolbar.heightAnchor.constraint(equalToConstant: 68),

            controls.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor, constant: 10),
            controls.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor, constant: -10),
            controls.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor, constant: -8),
            controls.heightAnchor.constraint(equalToConstant: 28),

            separator.leadingAnchor.constraint(equalTo: toolbar.leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: toolbar.trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: toolbar.bottomAnchor),

            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: toolbar.bottomAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private static func makeButton(symbol: String, label: String) -> NSButton {
        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(configuration) ?? NSImage(size: NSSize(width: 16, height: 16))
        let button = NSButton(image: image, target: nil, action: nil)
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.imageScaling = .scaleProportionallyDown
        button.toolTip = label
        button.setAccessibilityLabel(label)
        button.widthAnchor.constraint(equalToConstant: 26).isActive = true
        button.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return button
    }

    private static func httpURL(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    @objc private func goBack() {
        webView.goBack()
    }

    @objc private func goForward() {
        webView.goForward()
    }

    @objc private func reload() {
        webView.reload()
    }

    @objc private func openExternal() {
        guard let url = representedURL.flatMap(Self.httpURL) else { return }
        onOpenExternal?(url)
    }

    @objc private func close() {
        onClose?()
    }
}

#if DEBUG
    extension DashboardLinkBrowserView {
        var _testRepresentedURL: URL? {
            representedURL
        }

        var _testNavigationObservationCount: Int {
            navigationObservations.count
        }
    }
#endif
