#if os(iOS)
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import OpenClawChatUI

@MainActor
struct ChatComposerTextViewIOSTests {
    @Test func `configured composer uses native multiline input`() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()

        #expect(textView.isEditable)
        #expect(textView.isSelectable)
        #expect(!textView.allowsEditingTextAttributes)
        #expect(textView.returnKeyType == .default)
        #expect(textView.textContainerInset == .zero)
        #expect(textView.textContainer.lineFragmentPadding == 0)
        #expect(textView.accessibilityIdentifier == "chat-message-input")
    }

    @Test func `return insertion respects caret and selection`() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        textView.text = "firstsecond"
        textView.selectedRange = NSRange(location: 5, length: 0)

        textView.insertText("\n")

        #expect(textView.text == "first\nsecond")
        #expect(textView.selectedRange == NSRange(location: 6, length: 0))

        textView.selectedRange = NSRange(location: 0, length: 5)
        textView.insertText("\n")

        #expect(textView.text == "\n\nsecond")
        #expect(textView.selectedRange == NSRange(location: 1, length: 0))
    }

    @Test func `physical arrow keys route through the focused editor`() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        var upContexts: [Bool] = []
        var downCalls = 0
        textView.onHistoryUp = { caretOnFirstLine in
            upContexts.append(caretOnFirstLine)
            return true
        }
        textView.onHistoryDown = {
            downCalls += 1
            return true
        }
        textView.text = "first\nsecond"

        textView.selectedRange = NSRange(location: 2, length: 0)
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: []))

        textView.selectedRange = NSRange(location: 8, length: 0)
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: []))
        #expect(textView.handleHardwareKey(.keyboardDownArrow, modifierFlags: []))

        #expect(upContexts == [true, false])
        #expect(downCalls == 1)
        for modifiers in [UIKeyModifierFlags.shift, .control, .alternate, .command] {
            #expect(!textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: modifiers))
            #expect(!textView.handleHardwareKey(.keyboardDownArrow, modifierFlags: modifiers))
        }
        #expect(upContexts == [true, false])
        #expect(downCalls == 1)
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: .alphaShift))
        #expect(!textView.handleHardwareKey(.keyboardReturnOrEnter, modifierFlags: []))

        textView.onHistoryUp = { _ in false }
        textView.onHistoryDown = { false }
        #expect(!textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: []))
        #expect(!textView.handleHardwareKey(.keyboardDownArrow, modifierFlags: []))
    }

    @Test(arguments: [UIKeyboardHIDUsage.keyboardUpArrow, .keyboardDownArrow], [false, true])
    func `arrow keys preserve editor state and active recall`(
        keyCode: UIKeyboardHIDUsage,
        hasMarkedText: Bool) throws
    {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        let draft = "  working draft\nstill editing  "
        var history = ChatInputHistory()
        history.record("older")
        history.record("ka newer")
        let recalled = history.previous(draft: draft)
        textView.text = try #require(recalled)
        try #require(history.cursor == 0)

        var upCalls = 0
        var downCalls = 0
        textView.onHistoryUp = { _ in
            upCalls += 1
            guard let recalled = history.previous(draft: textView.text) else { return false }
            textView.text = recalled
            return true
        }
        textView.onHistoryDown = {
            downCalls += 1
            guard let recalled = history.next() else { return false }
            textView.text = recalled
            return true
        }
        defer {
            textView.onHistoryUp = nil
            textView.onHistoryDown = nil
        }

        textView.selectedRange = NSRange(location: 0, length: 2)
        if hasMarkedText {
            textView.setMarkedText("ka", selectedRange: NSRange(location: 2, length: 0))
            let markedRange = try #require(textView.markedTextRange)
            try #require(textView.selectedRange.length == 0)
            try #require(textView.offset(from: textView.beginningOfDocument, to: markedRange.start) == 0)
            try #require(textView.offset(from: markedRange.start, to: markedRange.end) == 2)
            try #require(textView.text(in: markedRange) == "ka")
        } else {
            try #require(textView.markedTextRange == nil)
            try #require(textView.selectedRange == NSRange(location: 0, length: 2))
        }

        let textBefore = textView.text
        let selectionBefore = textView.selectedRange
        let historyBefore = history
        #expect(!textView.handleHardwareKey(keyCode, modifierFlags: []))
        #expect(upCalls == 0)
        #expect(downCalls == 0)
        #expect(textView.text == textBefore)
        #expect(textView.selectedRange == selectionBefore)
        #expect(history == historyBefore)
        if hasMarkedText {
            let markedRange = try #require(textView.markedTextRange)
            #expect(textView.offset(from: textView.beginningOfDocument, to: markedRange.start) == 0)
            #expect(textView.offset(from: markedRange.start, to: markedRange.end) == 2)
            #expect(textView.text(in: markedRange) == "ka")
            textView.unmarkText()
        } else {
            textView.selectedRange = NSRange(location: 0, length: 0)
        }
        try #require(textView.markedTextRange == nil)
        try #require(textView.selectedRange.length == 0)

        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: []))
        #expect(textView.text == "older")
        #expect(textView.handleHardwareKey(.keyboardDownArrow, modifierFlags: []))
        #expect(textView.text == "ka newer")
        #expect(textView.handleHardwareKey(.keyboardDownArrow, modifierFlags: []))
        #expect(textView.text == draft)
        #expect(!history.isRecalling)
        #expect(history.stashedDraft == nil)
        #expect(upCalls == 1)
        #expect(downCalls == 2)
    }

    @Test func `pasted images become attachments and text falls through`() throws {
        // A private pasteboard avoids the iOS paste prompt that reading the general one triggers.
        let pasteboard = try #require(UIPasteboard.withUniqueName())
        defer { UIPasteboard.remove(withName: pasteboard.name) }
        let png = try #require(UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).image { _ in }.pngData())
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        var pasted: [ChatComposerPasteSupport.ImageAttachment] = []
        textView.onPasteImageAttachment = { pasted.append(($0, $1, $2)) }

        pasteboard.setData(png, forPasteboardType: UTType.png.identifier)
        #expect(textView.pasteImageAttachments(from: pasteboard))
        #expect(pasted.map(\.fileName) == ["pasted-image-1.png"])
        #expect(pasted.map(\.mimeType) == ["image/png"])
        #expect(pasted.first?.data == png)

        // Photos and screenshots may land as a UIImage rather than raw PNG bytes.
        pasted = []
        pasteboard.image = UIImage(data: png)
        #expect(textView.pasteImageAttachments(from: pasteboard))
        #expect(pasted.count == 1)

        pasted = []
        pasteboard.string = "plain text"
        #expect(!textView.pasteImageAttachments(from: pasteboard))

        // Upload transcoding cannot decode SVG, so a vector-first item uses its bitmap representation.
        let provider = NSItemProvider()
        for (type, data) in [(UTType.svg, Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8)), (.png, png)] {
            provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { completion in
                completion(data, nil)
                return nil
            }
        }
        pasteboard.itemProviders = [provider]
        #expect(pasteboard.types(forItemSet: IndexSet(integer: 0))?.first?.first == UTType.svg.identifier)
        #expect(textView.pasteImageAttachments(from: pasteboard))
        #expect(pasted.map(\.mimeType) == ["image/png"])

        pasted = []
        pasteboard.image = UIImage(data: png)
        textView.onPasteImageAttachment = nil
        #expect(!textView.pasteImageAttachments(from: pasteboard))
        #expect(pasted.isEmpty)
    }
}
#endif
