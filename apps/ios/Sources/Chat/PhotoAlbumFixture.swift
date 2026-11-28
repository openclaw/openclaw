import CoreGraphics
import Foundation
import ImageIO
import OpenClawChatUI
import UniformTypeIdentifiers

/// One deterministic collection for transcript and viewer screenshots. No photo library access.
enum PhotoAlbumFixture {
    static var messages: [OpenClawChatMessage]? {
        #if DEBUG
        self.message(timestamp: Date().timeIntervalSince1970 * 1000).map { [$0] }
        #else
        nil
        #endif
    }

    #if DEBUG
    static let flag = "--openclaw-photo-album-fixture"
    private static let prefix = "artifact_managed_image_album-"
    private static let inbound = "media://inbound/album-"

    static func message(timestamp: Double) -> OpenClawChatMessage? {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: self.flag), args.indices.contains(flag + 1),
              let count = Int(args[flag + 1]), [5, 9, 20].contains(count) else { return nil }
        let user = !args.contains("--openclaw-photo-album-assistant")
        var content = (1...count).map { index in
            OpenClawChatMessageContent(
                type: "image",
                mimeType: "image/png",
                fileName: "Study \(index).png",
                artifactId: user ? nil : self.prefix + String(index),
                url: user ? self.inbound + String(index) : nil,
                alt: "Study \(index)",
                width: 768,
                height: 768)
        }
        if !args.contains("--openclaw-photo-album-no-text") {
            content.append(.init(type: "text", text: "Compare the first image with the last one."))
        }
        return .init(role: user ? "user" : "assistant", content: content, timestamp: timestamp)
    }

    static func image(id: String, side: Int) -> OpenClawChatMediaData? {
        guard ProcessInfo.processInfo.arguments.contains(self.flag),
              let prefix = [self.prefix, self.inbound].first(where: { id.hasPrefix($0) }),
              let index = Int(id.dropFirst(prefix.count)), (1...20).contains(index),
              let context = CGContext(
                  data: nil,
                  width: side,
                  height: side,
                  bitsPerComponent: 8,
                  bytesPerRow: 0,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        context.scaleBy(x: CGFloat(side), y: CGFloat(side))
        let hues = [(0.29, 0.53, 0.63), (0.74, 0.46, 0.29), (0.36, 0.54, 0.40), (0.53, 0.44, 0.62)]
        let (r, g, b) = hues[(index - 1) % hues.count]
        context.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        let x = CGFloat(index % 7) / 12 + 0.15
        context.setFillColor(CGColor(gray: 1, alpha: 0.72))
        context.fillEllipse(in: CGRect(x: x, y: 0.65, width: 0.15, height: 0.15))
        context.setFillColor(CGColor(gray: 0, alpha: 0.42))
        context.move(to: .zero)
        context.addLine(to: CGPoint(x: x, y: 0.58))
        context.addLine(to: CGPoint(x: 1, y: 0.05))
        context.addLine(to: CGPoint(x: 1, y: 0))
        context.closePath()
        context.fillPath()
        let data = NSMutableData()
        guard let image = context.makeImage(),
              let out = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(out, image, nil)
        guard CGImageDestinationFinalize(out) else { return nil }
        return .init(data: data as Data, mimeType: "image/png")
    }
    #endif
}

#if DEBUG
extension LocalFixtureChatTransport {
    func loadImageThumbnail(sessionKey _: String, artifactId: String) async throws -> OpenClawChatMediaData? {
        PhotoAlbumFixture.image(id: artifactId, side: 480)
    }

    func loadMediaArtifact(
        sessionKey _: String,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        playback _: OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?
    {
        guard kind == .image else { return nil }
        return PhotoAlbumFixture.image(id: artifactId, side: 768).map(OpenClawChatLoadedMedia.data)
    }
}
#endif
