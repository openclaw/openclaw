#if os(macOS)
import AppKit
import Foundation
import Testing
@testable import OpenClawChatUI

@Suite(.serialized)
@MainActor
struct ChatComposerPasteSupportTests {
    @Test func `extracts image data from PNG clipboard payload`() throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        let item = NSPasteboardItem()
        let pngData = try self.samplePNGData()

        pasteboard.clearContents()
        item.setData(pngData, forType: .png)
        #expect(pasteboard.writeObjects([item]))

        let attachments = ChatComposerPasteSupport.imageAttachments(from: pasteboard)

        #expect(attachments.count == 1)
        #expect(attachments[0].data == pngData)
        #expect(attachments[0].fileName == "pasted-image-1.png")
        #expect(attachments[0].mimeType == "image/png")
    }

    @Test func `forwards file UR ls without reading or restricting types`() {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("test-\(UUID().uuidString)"))
        defer { pasteboard.releaseGlobally() }
        let urls = ["image.png", "report.pdf", "audio.mp3", "notes.txt"].map {
            FileManager.default.temporaryDirectory.appendingPathComponent($0)
        }

        pasteboard.clearContents()
        #expect(pasteboard.writeObjects(urls.map { $0 as NSURL }))
        #expect(ChatComposerPasteSupport.fileURLs(from: pasteboard) == urls)
        #expect(ChatComposerPasteSupport.fileURLs(from: pasteboard, matching: .png).isEmpty)
    }

    private func samplePNGData() throws -> Data {
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus()
        NSColor.systemBlue.setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 4, height: 4)).fill()
        image.unlockFocus()

        let tiffData = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiffData))
        return try #require(bitmap.representation(using: .png, properties: [:]))
    }
}
#endif
