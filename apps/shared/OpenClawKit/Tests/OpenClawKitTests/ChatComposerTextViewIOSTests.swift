#if os(iOS)
import Testing
import UIKit
import UniformTypeIdentifiers
@testable import OpenClawChatUI

@Suite
@MainActor
struct ChatComposerTextViewIOSTests {
    @Test func configuredComposerUsesNativeMultilineInput() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()

        #expect(textView.isEditable)
        #expect(textView.isSelectable)
        #expect(!textView.allowsEditingTextAttributes)
        #expect(textView.returnKeyType == .default)
        #expect(textView.textContainerInset == .zero)
        #expect(textView.textContainer.lineFragmentPadding == 0)
        #expect(textView.accessibilityIdentifier == "chat-message-input")
    }

    @Test func returnInsertionRespectsCaretAndSelection() {
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

    @Test func physicalArrowKeysRouteThroughTheFocusedEditor() {
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
        #expect(!textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: .shift))
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: .alphaShift))
        #expect(!textView.handleHardwareKey(.keyboardReturnOrEnter, modifierFlags: []))
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
