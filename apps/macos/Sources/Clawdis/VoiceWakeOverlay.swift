import AppKit
import OSLog
import QuartzCore
import SwiftUI

/// Lightweight, borderless panel that shows the current voice wake transcript near the menu bar.
@MainActor
final class VoiceWakeOverlayController: ObservableObject {
    static let shared = VoiceWakeOverlayController()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "voicewake.overlay")

    enum Source: String { case wakeWord, pushToTalk }

    @Published private(set) var model = Model()
    var isVisible: Bool { self.model.isVisible }

    struct Model {
        var text: String = ""
        var isFinal: Bool = false
        var isVisible: Bool = false
        var forwardEnabled: Bool = false
        var isSending: Bool = false
        var attributed: NSAttributedString = .init(string: "")
        var isOverflowing: Bool = false
        var isEditing: Bool = false
        var level: Double = 0 // normalized 0...1 speech level for UI
    }

    private var window: NSPanel?
    private var hostingView: NSHostingView<VoiceWakeOverlayView>?
    private var autoSendTask: Task<Void, Never>?
    private var autoSendToken: UUID?
    private var activeToken: UUID?
    private var activeSource: Source?

    private let width: CGFloat = 360
    private let padding: CGFloat = 10
    private let buttonWidth: CGFloat = 36
    private let spacing: CGFloat = 8
    private let verticalPadding: CGFloat = 8
    private let maxHeight: CGFloat = 400
    private let minHeight: CGFloat = 48
    let closeOverflow: CGFloat = 10

    @discardableResult
    func startSession(
        token: UUID = UUID(),
        source: Source,
        transcript: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        isFinal: Bool = false) -> UUID
    {
        let message = """
        overlay session_start source=\(source.rawValue) \
        len=\(transcript.count)
        """
        self.logger.log(level: .info, "\(message)")
        self.activeToken = token
        self.activeSource = source
        self.autoSendTask?.cancel(); self.autoSendTask = nil; self.autoSendToken = nil
        self.model.text = transcript
        self.model.isFinal = isFinal
        self.model.forwardEnabled = forwardEnabled
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
        self.present()
        self.updateWindowFrame(animate: true)
        return token
    }

    func snapshot() -> (token: UUID?, source: Source?, text: String, isVisible: Bool) {
        (self.activeToken, self.activeSource, self.model.text, self.model.isVisible)
    }

    func updatePartial(token: UUID, transcript: String, attributed: NSAttributedString? = nil) {
        guard self.guardToken(token, context: "partial") else { return }
        guard !self.model.isFinal else { return }
        let message = """
        overlay partial token=\(token.uuidString) \
        len=\(transcript.count)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel(); self.autoSendTask = nil; self.autoSendToken = nil
        self.model.text = transcript
        self.model.isFinal = false
        self.model.forwardEnabled = false
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
        self.present()
        self.updateWindowFrame(animate: true)
    }

    func presentFinal(
        token: UUID,
        transcript: String,
        autoSendAfter delay: TimeInterval?,
        sendChime: VoiceWakeChime = .none,
        attributed: NSAttributedString? = nil)
    {
        guard self.guardToken(token, context: "final") else { return }
        let message = """
        overlay presentFinal token=\(token.uuidString) \
        len=\(transcript.count) \
        autoSendAfter=\(delay ?? -1) \
        forwardEnabled=\(!transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel()
        self.autoSendToken = token
        self.model.text = transcript
        self.model.isFinal = true
        self.model.forwardEnabled = !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
        self.present()
        if let delay {
            if delay <= 0 {
                self.logger.log(level: .info, "overlay autoSend immediate token=\(token.uuidString)")
                VoiceSessionCoordinator.shared.sendNow(token: token, reason: "autoSendImmediate")
            } else {
                self.scheduleAutoSend(token: token, after: delay)
            }
        }
    }

    func userBeganEditing() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = true
    }

    func cancelEditingAndDismiss() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = false
        self.dismiss(reason: .explicit)
    }

    func endEditing() {
        self.model.isEditing = false
    }

    func updateText(_ text: String) {
        self.model.text = text
        self.model.isSending = false
        self.model.attributed = self.makeAttributed(from: text)
        self.updateWindowFrame(animate: true)
    }

    /// UI-only path: show sending state and dismiss; actual forwarding is handled by the coordinator.
    func beginSendUI(token: UUID, sendChime: VoiceWakeChime = .none) {
        guard self.guardToken(token, context: "beginSendUI") else { return }
        self.autoSendTask?.cancel(); self.autoSendToken = nil
        let message = """
        overlay beginSendUI token=\(token.uuidString) \
        isSending=\(self.model.isSending) \
        forwardEnabled=\(self.model.forwardEnabled) \
        textLen=\(self.model.text.count)
        """
        self.logger.log(level: .info, "\(message)")
        if self.model.isSending { return }
        self.model.isEditing = false

        if sendChime != .none {
            let message = "overlay beginSendUI playing sendChime=\(String(describing: sendChime))"
            self.logger.log(level: .info, "\(message)")
            VoiceWakeChimePlayer.play(sendChime, reason: "overlay.send")
        }

        self.model.isSending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            self.logger.log(
                level: .info,
                "overlay beginSendUI dismiss ticking token=\(self.activeToken?.uuidString ?? "nil")")
            self.dismiss(token: token, reason: .explicit, outcome: .sent)
        }
    }

    func requestSend(token: UUID? = nil, reason: String = "overlay_request") {
        guard self.guardToken(token, context: "requestSend") else { return }
        guard let active = token ?? self.activeToken else { return }
        VoiceSessionCoordinator.shared.sendNow(token: active, reason: reason)
    }

    func dismiss(token: UUID? = nil, reason: DismissReason = .explicit, outcome: SendOutcome = .empty) {
        guard self.guardToken(token, context: "dismiss") else { return }
        let message = """
        overlay dismiss token=\(self.activeToken?.uuidString ?? "nil") \
        reason=\(String(describing: reason)) \
        outcome=\(String(describing: outcome)) \
        visible=\(self.model.isVisible) \
        sending=\(self.model.isSending)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel(); self.autoSendToken = nil
        self.model.isSending = false
        self.model.isEditing = false
        guard let window else { return }
        let target = self.dismissTargetFrame(for: window.frame, reason: reason, outcome: outcome)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            if let target {
                window.animator().setFrame(target, display: true)
            }
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in
                let dismissedToken = self.activeToken
                window.orderOut(nil)
                self.model.isVisible = false
                self.model.level = 0
                self.activeToken = nil
                self.activeSource = nil
                if outcome == .empty {
                    AppStateStore.shared.blinkOnce()
                } else if outcome == .sent {
                    AppStateStore.shared.celebrateSend()
                }
                AppStateStore.shared.stopVoiceEars()
                VoiceSessionCoordinator.shared.overlayDidDismiss(token: dismissedToken)
            }
        }
    }

    func updateLevel(token: UUID, _ level: Double) {
        guard self.guardToken(token, context: "level") else { return }
        self.model.level = max(0, min(1, level))
    }

    enum DismissReason { case explicit, empty }
    enum SendOutcome { case sent, empty }

    // MARK: - Private

    private func guardToken(_ token: UUID?, context: String) -> Bool {
        switch Self.evaluateToken(active: self.activeToken, incoming: token) {
        case .accept:
            return true
        case .dropMismatch:
            self.logger.log(
                level: .info,
                """
                overlay drop \(context, privacy: .public) token_mismatch \
                active=\(self.activeToken?.uuidString ?? "nil", privacy: .public) \
                got=\(token?.uuidString ?? "nil", privacy: .public)
                """)
            return false
        case .dropNoActive:
            self.logger.log(level: .info, "overlay drop \(context, privacy: .public) no_active")
            return false
        }
    }

    enum GuardOutcome { case accept, dropMismatch, dropNoActive }

    nonisolated static func evaluateToken(active: UUID?, incoming: UUID?) -> GuardOutcome {
        guard let active else { return .dropNoActive }
        if let incoming, incoming != active { return .dropMismatch }
        return .accept
    }

    private func present() {
        self.ensureWindow()
        self.hostingView?.rootView = VoiceWakeOverlayView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        if !self.model.isVisible {
            self.model.isVisible = true
            self.logger.log(
                level: .info,
                "overlay present windowShown textLen=\(self.model.text.count, privacy: .public)")
            // Keep the status item in “listening” mode until we explicitly dismiss the overlay.
            AppStateStore.shared.triggerVoiceEars(ttl: nil)
            let start = target.offsetBy(dx: 0, dy: -6)
            window.setFrame(start, display: true)
            window.alphaValue = 0
            window.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            self.updateWindowFrame(animate: true)
            window.orderFrontRegardless()
        }
    }

    private func ensureWindow() {
        if self.window != nil { return }
        let borderPad = self.closeOverflow
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: self.width + borderPad * 2, height: 60 + borderPad * 2),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true

        let host = NSHostingView(rootView: VoiceWakeOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let height = self.measuredHeight()
        let size = NSSize(width: self.width + self.closeOverflow * 2, height: height + self.closeOverflow * 2)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width,
            y: visible.maxY - size.height)
        return NSRect(origin: origin, size: size)
    }

    func updateWindowFrame(animate: Bool = false) {
        guard let window else { return }
        let frame = self.targetFrame()
        if animate {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(frame, display: true)
            }
        } else {
            window.setFrame(frame, display: true)
        }
    }

    private func measuredHeight() -> CGFloat {
        let attributed = self.model.attributed.length > 0 ? self.model.attributed : self
            .makeAttributed(from: self.model.text)
        let maxWidth = self.width - (self.padding * 2) - self.spacing - self.buttonWidth

        let textInset = NSSize(width: 2, height: 6)
        let lineFragmentPadding: CGFloat = 0
        let containerWidth = max(1, maxWidth - (textInset.width * 2) - (lineFragmentPadding * 2))

        let storage = NSTextStorage(attributedString: attributed)
        let container = NSTextContainer(containerSize: CGSize(width: containerWidth, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = lineFragmentPadding
        container.lineBreakMode = .byWordWrapping

        let layout = NSLayoutManager()
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)

        _ = layout.glyphRange(for: container)
        let used = layout.usedRect(for: container)

        let contentHeight = ceil(used.height + (textInset.height * 2))
        let total = contentHeight + self.verticalPadding * 2
        self.model.isOverflowing = total > self.maxHeight
        return max(self.minHeight, min(total, self.maxHeight))
    }

    private func dismissTargetFrame(for frame: NSRect, reason: DismissReason, outcome: SendOutcome) -> NSRect? {
        switch (reason, outcome) {
        case (.empty, _):
            let scale: CGFloat = 0.95
            let newSize = NSSize(width: frame.size.width * scale, height: frame.size.height * scale)
            let dx = (frame.size.width - newSize.width) / 2
            let dy = (frame.size.height - newSize.height) / 2
            return NSRect(x: frame.origin.x + dx, y: frame.origin.y + dy, width: newSize.width, height: newSize.height)
        case (.explicit, .sent):
            return frame.offsetBy(dx: 8, dy: 6)
        default:
            return frame
        }
    }

    private func scheduleAutoSend(token: UUID, after delay: TimeInterval) {
        self.logger.log(
            level: .info,
            """
            overlay scheduleAutoSend token=\(token.uuidString) \
            after=\(delay)
            """)
        self.autoSendTask?.cancel()
        self.autoSendToken = token
        self.autoSendTask = Task<Void, Never> { [weak self, token] in
            let nanos = UInt64(max(0, delay) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self else { return }
                guard self.guardToken(token, context: "autoSend") else { return }
                self.logger.log(
                    level: .info,
                    "overlay autoSend firing token=\(token.uuidString, privacy: .public)")
                VoiceSessionCoordinator.shared.sendNow(token: token, reason: "autoSendDelay")
                self.autoSendTask = nil
            }
        }
    }

    func makeAttributed(from text: String) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
            ])
    }
}

private struct VoiceWakeOverlayView: View {
    @ObservedObject var controller: VoiceWakeOverlayController
    @FocusState private var textFocused: Bool
    @State private var isHovering: Bool = false
    @State private var closeHovering: Bool = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            HStack(alignment: .top, spacing: 8) {
                if self.controller.model.isEditing {
                    TranscriptTextView(
                        text: Binding(
                            get: { self.controller.model.text },
                            set: { self.controller.updateText($0) }),
                        attributed: self.controller.model.attributed,
                        isFinal: self.controller.model.isFinal,
                        isOverflowing: self.controller.model.isOverflowing,
                        onBeginEditing: {
                            self.controller.userBeganEditing()
                        },
                        onEscape: {
                            self.controller.cancelEditingAndDismiss()
                        },
                        onEndEditing: {
                            self.controller.endEditing()
                        },
                        onSend: {
                            self.controller.requestSend()
                        })
                        .focused(self.$textFocused)
                        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: .infinity, alignment: .topLeading)
                        .id("editing")
                } else {
                    VibrantLabelView(
                        attributed: self.controller.model.attributed,
                        onTap: {
                            self.controller.userBeganEditing()
                            self.textFocused = true
                        })
                        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: .infinity, alignment: .topLeading)
                        .id("display")
                }

                Button {
                    self.controller.requestSend()
                } label: {
                    let sending = self.controller.model.isSending
                    let level = self.controller.model.level
                    ZStack {
                        GeometryReader { geo in
                            let width = geo.size.width
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.accentColor.opacity(0.12))
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.accentColor.opacity(0.25))
                                .frame(width: width * max(0, min(1, level)), alignment: .leading)
                                .animation(.easeOut(duration: 0.08), value: level)
                        }
                        .frame(height: 28)

                        ZStack {
                            Image(systemName: "paperplane.fill")
                                .opacity(sending ? 0 : 1)
                                .scaleEffect(sending ? 0.5 : 1)
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .opacity(sending ? 1 : 0)
                                .scaleEffect(sending ? 1.05 : 0.8)
                        }
                        .imageScale(.small)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .frame(width: 32, height: 28)
                    .animation(.spring(response: 0.35, dampingFraction: 0.78), value: sending)
                }
                .buttonStyle(.plain)
                .disabled(!self.controller.model.forwardEnabled || self.controller.model.isSending)
                .keyboardShortcut(.return, modifiers: [.command])
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background {
                let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
                VisualEffectView(material: .hudWindow, blendingMode: .behindWindow)
                    .clipShape(shape)
                    .overlay(shape.strokeBorder(Color.white.opacity(0.16), lineWidth: 1))
            }
            .shadow(color: Color.black.opacity(0.22), radius: 14, x: 0, y: -2)
            .onHover { self.isHovering = $0 }

            // Close button rendered above and outside the clipped bubble
            CloseButtonOverlay(
                isVisible: self.controller.model.isEditing || self.isHovering || self.closeHovering,
                onHover: { self.closeHovering = $0 },
                onClose: { self.controller.cancelEditingAndDismiss() })
        }
        .padding(.top, self.controller.closeOverflow)
        .padding(.leading, self.controller.closeOverflow)
        .padding(.trailing, self.controller.closeOverflow)
        .padding(.bottom, self.controller.closeOverflow)
        .onAppear { self.textFocused = false }
        .onChange(of: self.controller.model.text) { _, _ in
            self.textFocused = self.controller.model.isEditing
        }
        .onChange(of: self.controller.model.isVisible) { _, visible in
            if visible { self.textFocused = self.controller.model.isEditing }
        }
        .onChange(of: self.controller.model.isEditing) { _, editing in
            self.textFocused = editing
        }
        .onChange(of: self.controller.model.attributed) { _, _ in
            self.controller.updateWindowFrame(animate: true)
        }
    }
}

private struct TranscriptTextView: NSViewRepresentable {
    @Binding var text: String
    var attributed: NSAttributedString
    var isFinal: Bool
    var isOverflowing: Bool
    var onBeginEditing: () -> Void
    var onEscape: () -> Void
    var onEndEditing: () -> Void
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = TranscriptNSTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.isRichText = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.font = .systemFont(ofSize: 13, weight: .regular)
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainerInset = NSSize(width: 2, height: 6)

        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]

        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true

        textView.textStorage?.setAttributedString(self.attributed)
        textView.typingAttributes = [
            .foregroundColor: NSColor.labelColor,
            .font: NSFont.systemFont(ofSize: 13, weight: .regular),
        ]
        textView.focusRingType = .none
        textView.onSend = { [weak textView] in
            textView?.window?.makeFirstResponder(nil)
            self.onSend()
        }
        textView.onBeginEditing = self.onBeginEditing
        textView.onEscape = self.onEscape
        textView.onEndEditing = self.onEndEditing

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.hasHorizontalScroller = false
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? TranscriptNSTextView else { return }
        let isEditing = scrollView.window?.firstResponder == textView
        if isEditing {
            return
        }

        if !textView.attributedString().isEqual(to: self.attributed) {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.textStorage?.setAttributedString(self.attributed)
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranscriptTextView
        var isProgrammaticUpdate = false

        init(_ parent: TranscriptTextView) { self.parent = parent }

        func textDidBeginEditing(_ notification: Notification) {
            self.parent.onBeginEditing()
        }

        func textDidEndEditing(_ notification: Notification) {
            self.parent.onEndEditing()
        }

        func textDidChange(_ notification: Notification) {
            guard !self.isProgrammaticUpdate else { return }
            guard let view = notification.object as? NSTextView else { return }
            guard view.window?.firstResponder === view else { return }
            self.parent.text = view.string
        }
    }
}

// MARK: - Vibrant display label

private struct VibrantLabelView: NSViewRepresentable {
    var attributed: NSAttributedString
    var onTap: () -> Void

    func makeNSView(context: Context) -> NSView {
        let label = NSTextField(labelWithAttributedString: self.attributed)
        label.isEditable = false
        label.isBordered = false
        label.drawsBackground = false
        label.lineBreakMode = .byWordWrapping
        label.maximumNumberOfLines = 0
        label.usesSingleLineMode = false
        label.cell?.wraps = true
        label.cell?.isScrollable = false
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        label.setContentHuggingPriority(.required, for: .vertical)
        label.setContentCompressionResistancePriority(.required, for: .vertical)
        label.textColor = .labelColor

        let container = ClickCatcher(onTap: onTap)
        container.addSubview(label)

        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            label.topAnchor.constraint(equalTo: container.topAnchor),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        return container
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard let container = nsView as? ClickCatcher,
              let label = container.subviews.first as? NSTextField else { return }
        label.attributedStringValue = self.attributed.strippingForegroundColor()
        label.textColor = .labelColor
    }
}

private final class ClickCatcher: NSView {
    let onTap: () -> Void
    init(onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        self.onTap()
    }
}

private struct CloseHoverButton: View {
    var onClose: () -> Void

    var body: some View {
        Button(action: self.onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Color.white.opacity(0.85))
                .frame(width: 22, height: 22)
                .background(Color.black.opacity(0.35))
                .clipShape(Circle())
                .shadow(color: Color.black.opacity(0.35), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .contentShape(Circle())
        .padding(6)
    }
}

private struct CloseButtonOverlay: View {
    var isVisible: Bool
    var onHover: (Bool) -> Void
    var onClose: () -> Void

    var body: some View {
        Group {
            if self.isVisible {
                Button(action: self.onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Color.white.opacity(0.9))
                        .frame(width: 22, height: 22)
                        .background(Color.black.opacity(0.4))
                        .clipShape(Circle())
                        .shadow(color: Color.black.opacity(0.45), radius: 10, x: 0, y: 3)
                        .shadow(color: Color.black.opacity(0.2), radius: 2, x: 0, y: 0)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .contentShape(Circle())
                .padding(6)
                .onHover { self.onHover($0) }
                .offset(x: -9, y: -9)
                .transition(.opacity)
            }
        }
        .allowsHitTesting(self.isVisible)
    }
}

private final class TranscriptNSTextView: NSTextView {
    var onSend: (() -> Void)?
    var onBeginEditing: (() -> Void)?
    var onEndEditing: (() -> Void)?
    var onEscape: (() -> Void)?

    override func becomeFirstResponder() -> Bool {
        self.onBeginEditing?()
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        let result = super.resignFirstResponder()
        self.onEndEditing?()
        return result
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36
        let isEscape = event.keyCode == 53
        if isEscape {
            self.onEscape?()
            return
        }
        if isReturn, event.modifierFlags.contains(.command) {
            self.onSend?()
            return
        }
        if isReturn {
            if event.modifierFlags.contains(.shift) {
                super.insertNewline(nil)
                return
            }
            self.onSend?()
            return
        }
        super.keyDown(with: event)
    }
}
