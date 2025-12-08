import AppKit
import QuartzCore
import SwiftUI

/// Lightweight, borderless panel that shows the current voice wake transcript near the menu bar.
@MainActor
final class VoiceWakeOverlayController: ObservableObject {
    static let shared = VoiceWakeOverlayController()

    @Published private(set) var model = Model()

    struct Model {
        var text: String = ""
        var isFinal: Bool = false
        var isVisible: Bool = false
        var forwardEnabled: Bool = false
        var isSending: Bool = false
    }

    private var window: NSPanel?
    private var hostingView: NSHostingView<VoiceWakeOverlayView>?
    private var autoSendTask: Task<Void, Never>?
    private var forwardConfig: VoiceWakeForwardConfig?

    private let width: CGFloat = 360
    private let padding: CGFloat = 10

    func showPartial(transcript: String) {
        self.autoSendTask?.cancel()
        self.forwardConfig = nil
        self.model.text = transcript
        self.model.isFinal = false
        self.model.forwardEnabled = false
        self.model.isSending = false
        self.present()
    }

    func presentFinal(transcript: String, forwardConfig: VoiceWakeForwardConfig) {
        self.autoSendTask?.cancel()
        self.forwardConfig = forwardConfig
        self.model.text = transcript
        self.model.isFinal = true
        self.model.forwardEnabled = forwardConfig.enabled
        self.model.isSending = false
        self.present()
        self.scheduleAutoSend()
    }

    func userBeganEditing() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
    }

    func updateText(_ text: String) {
        self.model.text = text
        self.model.isSending = false
        self.updateWindowFrame(animate: true)
    }

    func sendNow() {
        self.autoSendTask?.cancel()
        guard let forwardConfig, forwardConfig.enabled else {
            self.dismiss()
            return
        }
        let text = self.model.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            self.dismiss()
            return
        }

        self.model.isSending = true
        let payload = VoiceWakeForwarder.prefixedTranscript(text)
        Task.detached {
            await VoiceWakeForwarder.forward(transcript: payload, config: forwardConfig)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            self.dismiss()
        }
    }

    func dismiss(reason: DismissReason = .explicit) {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        guard let window else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in
                window.orderOut(nil)
                self.model.isVisible = false
            }
        }
    }

    enum DismissReason { case explicit, empty }

    // MARK: - Private

    private func present() {
        self.ensureWindow()
        self.hostingView?.rootView = VoiceWakeOverlayView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        if !self.model.isVisible {
            self.model.isVisible = true
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
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: self.width, height: 60),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
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
        guard let screen = NSScreen.main, let host = self.hostingView else {
            return .zero
        }
        host.layoutSubtreeIfNeeded()
        let fit = host.fittingSize
        let height = max(42, min(fit.height, 180))
        let size = NSSize(width: self.width, height: height)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width - self.padding,
            y: visible.maxY - size.height - self.padding)
        return NSRect(origin: origin, size: size)
    }

    private func updateWindowFrame(animate: Bool = false) {
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

    private func scheduleAutoSend() {
        guard let forwardConfig, forwardConfig.enabled else { return }
        self.autoSendTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            self?.sendNow()
        }
    }
}

private struct VoiceWakeOverlayView: View {
    @ObservedObject var controller: VoiceWakeOverlayController
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            TranscriptTextView(
                text: Binding(
                    get: { self.controller.model.text },
                    set: { self.controller.updateText($0) }),
                isFinal: self.controller.model.isFinal,
                onBeginEditing: {
                    self.controller.userBeganEditing()
                },
                onSend: {
                    self.controller.sendNow()
                })
                .focused(self.$focused)
                .frame(minHeight: 32, maxHeight: 80)

            Button {
                self.controller.sendNow()
            } label: {
                let sending = self.controller.model.isSending
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
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
                .background(Color.accentColor.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .animation(.spring(response: 0.35, dampingFraction: 0.78), value: sending)
            }
            .buttonStyle(.plain)
            .disabled(!self.controller.model.forwardEnabled || self.controller.model.isSending)
            .keyboardShortcut(.return, modifiers: [.command])
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 10)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 6)
        .onAppear { self.focused = false }
        .onChange(of: self.controller.model.text) { _, _ in
            self.focused = false
        }
        .onChange(of: self.controller.model.isVisible) { _, visible in
            if visible { self.focused = false }
        }
    }
}

private struct TranscriptTextView: NSViewRepresentable {
    @Binding var text: String
    var isFinal: Bool
    var onBeginEditing: () -> Void
    var onSend: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let textView = TranscriptNSTextView()
        textView.delegate = context.coordinator
        textView.drawsBackground = false
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.font = .systemFont(ofSize: 13, weight: .regular)
        textView.textContainerInset = NSSize(width: 2, height: 6)
        textView.textContainer?.lineBreakMode = .byWordWrapping
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.string = self.text
        textView.onSend = { [weak textView] in
            textView?.window?.makeFirstResponder(nil)
            self.onSend()
        }
        textView.onBeginEditing = self.onBeginEditing

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.documentView = textView
        return scroll
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? TranscriptNSTextView else { return }
        if textView.string != self.text {
            textView.string = self.text
        }
        textView.textColor = self.isFinal ? .labelColor : .secondaryLabelColor
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: TranscriptTextView

        init(_ parent: TranscriptTextView) { self.parent = parent }

        func textDidBeginEditing(_ notification: Notification) {
            self.parent.onBeginEditing()
        }

        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            self.parent.text = view.string
        }
    }
}

private final class TranscriptNSTextView: NSTextView {
    var onSend: (() -> Void)?
    var onBeginEditing: (() -> Void)?

    override func becomeFirstResponder() -> Bool {
        self.onBeginEditing?()
        return super.becomeFirstResponder()
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36
        if isReturn && event.modifierFlags.contains(.command) {
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
