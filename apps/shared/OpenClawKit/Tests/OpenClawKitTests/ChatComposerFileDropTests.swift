import Foundation
import Testing
@testable import OpenClawChatUI

#if os(macOS)
import AppKit

@Suite struct ChatComposerFileDropTests {
    @Test func composerRegistersForFileURLDrops() {
        let textView = ChatComposerNSTextView(frame: .zero)
        #expect(textView.registeredDraggedTypes.contains(.fileURL))
    }

    @Test func fileDropExtractorReadsFileURLsOnly() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("openclaw-chatcomposer-\(UUID().uuidString)"))
        pasteboard.clearContents()
        let fileURL = URL(fileURLWithPath: "/tmp/example.png")

        #expect(pasteboard.writeObjects([fileURL as NSURL]))
        #expect(ChatComposerFileDrop.fileURLs(from: pasteboard) == [fileURL])
    }

    @Test func fileDropExtractorIgnoresNonFileURLs() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("openclaw-chatcomposer-\(UUID().uuidString)"))
        pasteboard.clearContents()
        let webURL = try #require(NSURL(string: "https://docs.openclaw.ai/configuration"))

        #expect(pasteboard.writeObjects([webURL]))
        #expect(ChatComposerFileDrop.fileURLs(from: pasteboard).isEmpty)
    }
}
#endif
