#if os(macOS)
import AppKit
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatComposerTextViewTests {
    @Test func `configured composer text view enables undo`() {
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()

        #expect(textView.allowsUndo)
    }

    @Test(arguments: [
        ("\r\n", NSRange(location: 2, length: 0), false),
        ("a\u{2028}b", NSRange(location: 2, length: 0), false),
        ("a\u{2029}b", NSRange(location: 2, length: 0), false),
        ("ab\nc", NSRange(location: 1, length: 0), true),
        ("ab\nc", NSRange(location: 0, length: 1), false),
    ])
    func `plain Up reports whether the caret is on the first logical line`(
        _ draft: String,
        _ selection: NSRange,
        _ expectedFirstLine: Bool) throws
    {
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()
        textView.string = draft
        textView.setSelectedRange(selection)
        var reportedFirstLine: Bool?
        textView.onKeyCommand = { command, context in
            guard command == .moveUp else { return false }
            reportedFirstLine = context.caretOnFirstLine
            return context.caretOnFirstLine
        }
        let up = try #require(NSEvent.keyEvent(
            with: .keyDown,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            characters: "\u{F700}",
            charactersIgnoringModifiers: "\u{F700}",
            isARepeat: false,
            keyCode: 126))
        textView.keyDown(with: up)
        #expect(reportedFirstLine == expectedFirstLine)
    }

    @Test func `composer expands for wrapped drafts and shrinks when cleared without moving the caret`() {
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()
        textView.string = "Keep this draft"
        textView.setSelectedRange(NSRange(location: 4, length: 0))
        let draft = String(repeating: "A longer draft with room to think. ", count: 12)
        let empty = ChatComposerTextViewFactory.fittingHeight(text: "", width: 500, textView: textView)
        let wide = ChatComposerTextViewFactory.fittingHeight(text: draft, width: 500, textView: textView)
        let narrow = ChatComposerTextViewFactory.fittingHeight(text: draft, width: 220, textView: textView)
        let multiline = ChatComposerTextViewFactory.fittingHeight(
            text: "first\nsecond\n",
            width: 500,
            textView: textView)

        #expect(wide > empty)
        #expect(narrow > wide)
        #expect(multiline > empty * 2)
        #expect(ChatComposerTextViewFactory.fittingHeight(text: "", width: 220, textView: textView) == empty)
        #expect(textView.string == "Keep this draft")
        #expect(textView.selectedRange() == NSRange(location: 4, length: 0))
    }
}

struct ChatComposerKeyRoutingTests {
    @Test func `maps interceptable navigation keys`() {
        #expect(ChatComposerKeyRouting.command(keyCode: 126, modifierFlags: [], hasMarkedText: false) == .moveUp)
        #expect(ChatComposerKeyRouting.command(keyCode: 125, modifierFlags: [], hasMarkedText: false) == .moveDown)
        #expect(ChatComposerKeyRouting.command(keyCode: 48, modifierFlags: [], hasMarkedText: false) == .tab)
        #expect(ChatComposerKeyRouting.command(keyCode: 53, modifierFlags: [], hasMarkedText: false) == .escape)
        #expect(ChatComposerKeyRouting.command(keyCode: 36, modifierFlags: [], hasMarkedText: false) == .returnKey)
    }

    @Test func `ignores modified keys and IME composition`() {
        // Shift-Return must stay a newline and Cmd-arrows must stay text
        // navigation; IME composition owns Return while marked text exists.
        #expect(ChatComposerKeyRouting.command(keyCode: 36, modifierFlags: [.shift], hasMarkedText: false) == nil)
        #expect(ChatComposerKeyRouting.command(keyCode: 126, modifierFlags: [.command], hasMarkedText: false) == nil)
        #expect(ChatComposerKeyRouting.command(keyCode: 36, modifierFlags: [], hasMarkedText: true) == nil)
        #expect(ChatComposerKeyRouting.command(keyCode: 0, modifierFlags: [], hasMarkedText: false) == nil)
    }
}
#endif
