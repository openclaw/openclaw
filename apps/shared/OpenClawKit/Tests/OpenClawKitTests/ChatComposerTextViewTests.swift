import Testing
@testable import OpenClawChatUI

#if os(macOS)
@Suite struct ChatComposerTextViewTests {
    @Test func configuredTextViewEnablesUndo() {
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()
        #expect(textView.allowsUndo)
    }
}
#endif
