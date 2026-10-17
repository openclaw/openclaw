import AppKit
import ImageIO
import UniformTypeIdentifiers

/// WebKit gives pasted images to a page only from PNG, TIFF, JPEG, GIF, or SVG data.
/// HDR screenshots reach the clipboard as HEIC alone, so WebKit's paste event carries
/// no files. Chrome converts such clipboard images to PNG, which the web composer stages.
enum DashboardPastedImages {
    /// Clipboard content that WebKit's own paste delivers to the page.
    private static let webKitPasteTypes: [UTType] = [
        .text, .url, .rtfd, .flatRTFD, .webArchive, .png, .tiff, .jpeg, .gif, .svg,
    ]

    /// Returns image data for a paste that WebKit would deliver as nothing,
    /// or nil when WebKit's paste can deliver some of the clipboard.
    static func unreadableImages(in items: [NSPasteboardItem]) -> [Data]? {
        let itemTypes = items.map { $0.types.compactMap { UTType($0.rawValue) } }
        // Check every item before reading any data; promised data can be slow to arrive.
        let webKitCanPaste = itemTypes.joined().contains { type in
            self.webKitPasteTypes.contains { type.conforms(to: $0) }
        }
        guard !webKitCanPaste else { return nil }
        let images = zip(items, itemTypes).compactMap { item, types -> Data? in
            guard let image = types.first(where: { $0.conforms(to: .image) }) else { return nil }
            return item.data(forType: NSPasteboard.PasteboardType(image.identifier))
        }
        return images.isEmpty ? nil : images
    }

    /// Converts clipboard image data to a full-size PNG with its orientation applied
    /// and HDR content decoded to SDR.
    static func pngData(from imageData: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil) else { return nil }
        // ImageIO applies the EXIF orientation only when it creates a thumbnail. Without a
        // maximum pixel size, the thumbnail keeps the full image size.
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceDecodeRequest: kCGImageSourceDecodeToSDR,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        return CGImageDestinationFinalize(destination) ? output as Data : nil
    }
}
