import AppKit
import CryptoKit
import Foundation
import SwiftUI

// Private proof producer only; no OpenClaw resolver/cache or product-source dependency.
@MainActor
enum SourceReferenceProducer {
    static func image(url: URL, expectedSha256: String, loader: String) throws -> NSImage {
        let bytes = try Data(contentsOf: url)
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard hash == expectedSha256, loader == "data" || loader == "file",
              let image = loader == "file" ? NSImage(contentsOf: url) : NSImage(data: bytes)
        else { throw NSError(domain: "SourceReferenceProducer", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Verified native SVG decode unavailable"]) }
        image.isTemplate = true
        // Match production: do not assign NSImage.size or force a raster representation.
        return image
    }

    static func well(image: NSImage, sourcePaint: Bool) -> some View {
        ZStack {
            if sourcePaint {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.primary.opacity(0.06))
            }
            Image(nsImage: image).renderingMode(.template).resizable().scaledToFit()
                .foregroundStyle(.primary).frame(width: 18, height: 18)
        }.frame(width: 32, height: 32)
    }
}
