#if os(iOS)
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

@MainActor
struct ChatComposerTextViewIOS: UIViewRepresentable {
    @Environment(\.isEnabled) private var effectiveEnvironmentEnabled
    @Binding var text: String
    var focusRequested: Bool
    var isEnabled: Bool
    var minHeight: CGFloat
    var maxHeight: CGFloat
    var onFocusChange: (Bool) -> Void
    var onHistoryUp: (Bool) -> Bool
    var onHistoryDown: () -> Bool
    /// Nil leaves paste entirely to UIKit.
    var onPasteImageAttachment: ((_ data: Data, _ fileName: String, _ mimeType: String) -> Void)?

    private var interactionEnabled: Bool {
        self.isEnabled && self.effectiveEnvironmentEnabled
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> ChatComposerUITextView {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        textView.delegate = context.coordinator
        textView.text = self.text
        self.configureInputHandlers(textView)
        return textView
    }

    func updateUIView(_ textView: ChatComposerUITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.scheduleInteractionUpdate(textView)
        self.configureInputHandlers(textView)

        // Publishing native input can re-enter SwiftUI with the previous rendered value.
        guard !context.coordinator.isReportingTextChange else { return }
        let isEcho = context.coordinator.lastReportedText == self.text
        if textView.isFirstResponder, isEcho {
            return
        }

        if textView.text != self.text {
            context.coordinator.isProgrammaticUpdate = true
            defer { context.coordinator.isProgrammaticUpdate = false }
            textView.text = self.text
            if textView.isFirstResponder {
                textView.selectedRange = NSRange(location: (self.text as NSString).length, length: 0)
            }
            textView.invalidateIntrinsicContentSize()
        }
        context.coordinator.lastReportedText = self.text
    }

    private func configureInputHandlers(_ textView: ChatComposerUITextView) {
        textView.onHistoryUp = self.onHistoryUp
        textView.onHistoryDown = self.onHistoryDown
        textView.onPasteImageAttachment = self.onPasteImageAttachment
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ChatComposerUITextView,
        context _: Context) -> CGSize?
    {
        guard let width = proposal.width else { return nil }
        let fitting = uiView.sizeThatFits(
            CGSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        return CGSize(
            width: width,
            height: min(max(fitting.height, self.minHeight), self.maxHeight))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ChatComposerTextViewIOS
        var isProgrammaticUpdate = false
        private(set) var isReportingTextChange = false
        var lastReportedText: String?
        private var interactionUpdateScheduled = false

        init(_ parent: ChatComposerTextViewIOS) {
            self.parent = parent
        }

        func scheduleInteractionUpdate(_ textView: ChatComposerUITextView) {
            guard !self.interactionUpdateScheduled else { return }
            self.interactionUpdateScheduled = true
            // Disabling a focused UITextView synchronously resigns first responder.
            // Inside updateUIView that re-enters SwiftUI's responder graph and can
            // spin in AttributeGraph. Apply UIKit state after the graph update,
            // reading the latest parent so a queued disable cannot outlive recovery.
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self else { return }
                self.interactionUpdateScheduled = false
                guard let textView else { return }
                let isEnabled = self.parent.interactionEnabled
                if textView.isEditable != isEnabled {
                    textView.isEditable = isEnabled
                }
                if textView.isSelectable != isEnabled {
                    textView.isSelectable = isEnabled
                }
                // UIKit owns user-initiated focus; false is not a blur request.
                if self.parent.focusRequested, isEnabled,
                   !textView.isFirstResponder
                {
                    textView.becomeFirstResponder()
                } else if !isEnabled, textView.isFirstResponder {
                    textView.resignFirstResponder()
                }
            }
        }

        func textViewShouldBeginEditing(_ textView: UITextView) -> Bool {
            self.parent.interactionEnabled
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            self.parent.interactionEnabled
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            self.parent.onFocusChange(true)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            self.parent.onFocusChange(false)
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !self.isProgrammaticUpdate, textView.isFirstResponder else { return }
            self.isReportingTextChange = true
            defer { self.isReportingTextChange = false }
            self.lastReportedText = textView.text
            self.parent.text = textView.text
            textView.invalidateIntrinsicContentSize()
        }
    }
}

@MainActor
final class ChatComposerUITextView: UITextView {
    var onHistoryUp: ((Bool) -> Bool)?
    var onHistoryDown: (() -> Bool)?
    var onPasteImageAttachment: ((_ data: Data, _ fileName: String, _ mimeType: String) -> Void)?

    override var accessibilityTraits: UIAccessibilityTraits {
        // Preserve UIKit's dynamic keyboard-focus traits when exposing disabled input.
        get { self.isEditable ? super.accessibilityTraits : super.accessibilityTraits.union(.notEnabled) }
        set { super.accessibilityTraits = newValue }
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandledPresses = presses
        for press in presses {
            guard let key = press.key else { continue }
            if self.handleHardwareKey(key.keyCode, modifierFlags: key.modifierFlags) {
                unhandledPresses.remove(press)
            }
        }
        guard !unhandledPresses.isEmpty else { return }
        super.pressesBegan(unhandledPresses, with: event)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        // UITextView offers Paste only for text; screenshots and copied photos are image-only.
        // `hasImages` inspects types without reading contents, so it does not trigger the paste prompt.
        if action == #selector(self.paste(_:)), self.isEditable, self.onPasteImageAttachment != nil,
           UIPasteboard.general.hasImages
        {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        if !self.pasteImageAttachments(from: UIPasteboard.general) {
            super.paste(sender)
        }
    }

    /// Internal so tests can use a private pasteboard instead of the general one.
    func pasteImageAttachments(from pasteboard: UIPasteboard) -> Bool {
        guard let onPasteImageAttachment = self.onPasteImageAttachment, pasteboard.hasImages else { return false }
        let attachments = ChatComposerPasteSupport.imageAttachments(from: pasteboard)
        for attachment in attachments {
            onPasteImageAttachment(attachment.data, attachment.fileName, attachment.mimeType)
        }
        return !attachments.isEmpty
    }

    /// Internal for focused responder-level keyboard routing coverage.
    func handleHardwareKey(
        _ keyCode: UIKeyboardHIDUsage,
        modifierFlags: UIKeyModifierFlags) -> Bool
    {
        let commandModifiers: UIKeyModifierFlags = [.shift, .control, .alternate, .command]
        // UIKit owns composition and selection even while history recall is active.
        guard modifierFlags.isDisjoint(with: commandModifiers),
              self.markedTextRange == nil,
              self.selectedRange.length == 0
        else { return false }
        switch keyCode {
        case .keyboardUpArrow:
            return self.onHistoryUp?(self.caretOnFirstLine) == true
        case .keyboardDownArrow:
            return self.onHistoryDown?() == true
        default:
            return false
        }
    }

    private var caretOnFirstLine: Bool {
        let location = min(max(self.selectedRange.location, 0), (self.text as NSString).length)
        let prefix = (self.text as NSString).substring(to: location)
        return !prefix.contains("\n") && !prefix.contains("\r")
    }
}

enum ChatComposerPasteSupport {
    typealias ImageAttachment = (data: Data, fileName: String, mimeType: String)

    /// Upload transcoding decodes with ImageIO, so skip image types it cannot read, such as SVG.
    private static let decodableTypes = Set(CGImageSourceCopyTypeIdentifiers() as? [String] ?? [])

    /// Keeps each item's first decodable image representation, in the order the source app offered them.
    static func imageAttachments(from pasteboard: UIPasteboard) -> [ImageAttachment] {
        (0..<pasteboard.numberOfItems).compactMap { index in
            let itemSet = IndexSet(integer: index)
            for identifier in pasteboard.types(forItemSet: itemSet)?.first ?? [] {
                guard self.decodableTypes.contains(identifier), let type = UTType(identifier),
                      let mimeType = type.preferredMIMEType,
                      let data = pasteboard.data(forPasteboardType: identifier, inItemSet: itemSet)?.first,
                      !data.isEmpty
                else { continue }
                let fileExtension = type.preferredFilenameExtension ?? "img"
                return (data: data, fileName: "pasted-image-\(index + 1).\(fileExtension)", mimeType: mimeType)
            }
            return nil
        }
    }
}

enum ChatComposerTextViewIOSFactory {
    /// Internal for @testable import coverage of native multiline input defaults.
    @MainActor
    static func makeConfiguredTextView() -> ChatComposerUITextView {
        let textView = ChatComposerUITextView()
        textView.backgroundColor = .clear
        textView.font = OpenClawChatTypography.bodyUIFont
        textView.adjustsFontForContentSizeCategory = true
        textView.allowsEditingTextAttributes = false
        textView.isScrollEnabled = true
        textView.showsVerticalScrollIndicator = false
        textView.textContainerInset = .zero
        textView.textContainer.lineFragmentPadding = 0
        textView.returnKeyType = .default
        textView.accessibilityIdentifier = "chat-message-input"
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return textView
    }
}
#endif
