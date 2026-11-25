import Foundation
import ImageIO
import SwiftUI

#if canImport(AppKit)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

enum ChatMediaImageDecoder {
    static let maximumThumbnailPixels = 2048

    static func decode(_ data: Data, maxPixelSize: Int = maximumThumbnailPixels) -> OpenClawPlatformImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        else { return nil }
        #if canImport(AppKit)
        return NSImage(cgImage: cgImage, size: .zero)
        #elseif canImport(UIKit)
        return UIImage(cgImage: cgImage)
        #endif
    }
}

#if os(iOS)
/// Decoded transcript images and their pixel sizes, per artifact, for the life of the process. A
/// row that scrolls back or a chat that reopens draws its image on the first frame instead of
/// downloading it again. Memory only: the app keeps no media on disk.
@MainActor
enum ChatMediaImageMemory {
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 96 * 1024 * 1024
        return cache
    }()

    /// Sizes outlive evicted images, so an evicted image still reserves its own shape.
    private static var sizes: [String: CGSize] = [:]

    static func image(for artifactId: String) -> UIImage? {
        self.images.object(forKey: artifactId as NSString)
    }

    static func size(for artifactId: String) -> CGSize? {
        self.sizes[artifactId]
    }

    static func store(_ image: UIImage, for artifactId: String) {
        let pixels = image.size.width * image.scale * image.size.height * image.scale
        self.images.setObject(image, forKey: artifactId as NSString, cost: Int(pixels) * 4)
        self.sizes[artifactId] = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
    }
}

/// The image's box in the transcript, from the Control UI's preview rule
/// (ui/src/pages/chat/components/chat-image-preview-size.ts): the source's own width between 160
/// and 400 points, no taller than 360, and 400 by 267 (3:2) when the size is unknown. Narrower
/// columns scale the box down. Its height follows only its width, never the height the row offers,
/// so a row laid out at a stale height cannot squeeze it.
struct ChatImageBox: Layout {
    let size: CGSize

    init(pixelSize: CGSize?) {
        guard let pixelSize, pixelSize.width > 0, pixelSize.height > 0 else {
            self.size = CGSize(width: 400, height: 400 / 1.5)
            return
        }
        let ratio = pixelSize.width / pixelSize.height
        let width = min(max(pixelSize.width, 160), 400, 360 * ratio)
        self.size = CGSize(width: width, height: width / ratio)
    }

    /// A square gallery tile (a user message with several images).
    init(tile side: CGFloat) {
        self.size = CGSize(width: side, height: side)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews _: Subviews, cache _: inout ()) -> CGSize {
        let width = min(self.size.width, proposal.width ?? self.size.width)
        return CGSize(width: width, height: width * self.size.height / self.size.width)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
        }
    }
}
#endif

@MainActor
struct ChatMediaImageAttachment: View {
    private enum LoadState {
        case loading
        case loaded(OpenClawPlatformImage)
        case unavailable
    }

    let artifactId: String
    let label: String
    let resolverReady: Bool
    /// The message's images, so the viewer can page through them. Empty means just this one.
    let gallery: [ChatImageViewerItem]
    let load: @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?
    #if os(iOS)
    /// The source's pixel size, when the Gateway sends it.
    let gatewaySize: CGSize?
    /// Set for a square gallery tile; the image fills it.
    let tileSide: CGFloat?
    /// A size remembered from an earlier load, read once when the row appears: adopting it later
    /// would reshape a box that is already on screen.
    @State private var rememberedSize: CGSize?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #endif

    @State private var state: LoadState
    @State private var retryGeneration = 0
    #if os(macOS)
    @State private var showsFullImage = false
    #endif

    init(
        artifactId: String,
        label: String,
        width: Int?,
        height: Int?,
        tileSide: CGFloat? = nil,
        resolverReady: Bool,
        gallery: [ChatImageViewerItem] = [],
        load: @escaping @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?)
    {
        self.artifactId = artifactId
        self.label = label
        self.resolverReady = resolverReady
        self.gallery = gallery
        self.load = load
        #if os(iOS)
        self.tileSide = tileSide
        if let width, let height, width > 0, height > 0 {
            self.gatewaySize = CGSize(width: width, height: height)
        } else {
            self.gatewaySize = nil
        }
        self._rememberedSize = State(initialValue: ChatMediaImageMemory.size(for: artifactId))
        self._state = State(initialValue: ChatMediaImageMemory.image(for: artifactId).map(LoadState.loaded) ?? .loading)
        #else
        self._state = State(initialValue: .loading)
        #endif
    }

    var body: some View {
        #if os(iOS)
        self.boxedImage
            .task(id: "\(self.artifactId):\(self.resolverReady):\(self.retryGeneration)") {
                await self.loadImage()
            }
        #else
        self.legacyBody
        #endif
    }

    #if os(iOS)
    private var pixelSize: CGSize? {
        self.gatewaySize ?? self.rememberedSize
    }

    /// One box from the first frame to the last: a still, faint rectangle in the transcript
    /// skeleton's ink while the bytes load, the image fading in over it, and the retry inside it if
    /// the load fails. The row never changes height because of the image.
    private var boxedImage: some View {
        // The bubble's corner: the Control UI pairs 20 px images with 18 px bubbles
        // (ui/src/styles/chat/message-layout.css:546-553, grouped.css:2089-2097).
        let shape = RoundedRectangle(cornerRadius: ChatImageViewerThumbnail.cornerRadius, style: .continuous)
        let box = self.tileSide.map { ChatImageBox(tile: $0) } ?? ChatImageBox(pixelSize: self.pixelSize)
        return box {
            ZStack {
                shape.fill(OpenClawChatTheme.assistantText.opacity(0.07))
                switch self.state {
                case .loading:
                    Color.clear
                case let .loaded(image):
                    Button {
                        ChatImageViewerController.present(
                            items: ChatImageViewerItem.viewerItems(
                                self.gallery,
                                opening: self.artifactId,
                                label: self.label),
                            artifactId: self.artifactId,
                            thumbnail: image,
                            load: self.load)
                    } label: {
                        // The UIKit thumbnail is the zoom transition's source. A known size or a
                        // tile fills its own box; an unknown size keeps the 3:2 box. It takes no
                        // touches, so the clear overlay gives the button its hit area.
                        ChatImageViewerThumbnail(
                            image: image,
                            artifactId: self.artifactId,
                            fillsProposal: self.pixelSize != nil || self.tileSide != nil)
                            .allowsHitTesting(false)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .overlay { Color.clear.contentShape(Rectangle()) }
                    }
                    .buttonStyle(.plain)
                    .transition(.opacity)
                    .accessibilityLabel(self.label)
                    .accessibilityAddTraits(.isImage)
                    .accessibilityHint(String(localized: "Opens the image full screen."))
                case .unavailable:
                    VStack(spacing: 6) {
                        Image(systemName: "photo.badge.exclamationmark")
                            .accessibilityHidden(true)
                        Text(String(localized: "Image unavailable"))
                        Button {
                            self.retryGeneration &+= 1
                        } label: {
                            Text(String(localized: "Try again"))
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.primary)
                    }
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(8)
                }
            }
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
        }
        .accessibilityElement(children: .contain)
        // The loaded image's button carries the name itself; the placeholder and the failed box
        // keep it on the box.
        .accessibilityLabel(self.isLoaded ? Text(verbatim: "") : Text(self.label))
    }

    private var isLoaded: Bool {
        if case .loaded = self.state { return true }
        return false
    }
    #else
    private var legacyBody: some View {
        Group {
            switch self.state {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView()
                    Text(String(localized: "Loading image…"))
                        .font(OpenClawChatTypography.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: 88)
                .frame(maxWidth: .infinity)
            case let .loaded(image):
                Button {
                    self.showsFullImage = true
                } label: {
                    OpenClawPlatformImageFactory.image(image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: 320)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(self.label)
                .accessibilityHint(String(localized: "Opens image preview"))
                .sheet(isPresented: self.$showsFullImage) {
                    ChatMediaImagePreview(image: image) { self.showsFullImage = false }
                }
            case .unavailable:
                ChatMediaUnavailableRow(
                    systemImage: "photo.badge.exclamationmark",
                    message: String(localized: "Image unavailable"))
                {
                    self.retryGeneration &+= 1
                }
            }
        }
        .task(id: "\(self.artifactId):\(self.resolverReady):\(self.retryGeneration)") {
            await self.loadImage()
        }
    }
    #endif

    private func loadImage() async {
        #if os(iOS)
        // A remembered image is already drawn; a closed connection keeps the still box until the
        // resolver is ready, which restarts this task.
        if case .loaded = self.state { return }
        guard self.resolverReady else { return }
        #else
        guard self.resolverReady else {
            self.state = .unavailable
            return
        }
        #endif
        self.state = .loading
        do {
            guard let loaded = try await self.load(self.artifactId), !Task.isCancelled else {
                if !Task.isCancelled { self.state = .unavailable }
                return
            }
            guard case let .data(media) = loaded,
                  media.mimeType.lowercased().hasPrefix("image/")
            else {
                self.state = .unavailable
                return
            }
            let image = await Task.detached(priority: .userInitiated) {
                ChatMediaImageDecoder.decode(media.data)
            }.value
            guard !Task.isCancelled else { return }
            #if os(iOS)
            guard let image else {
                self.state = .unavailable
                return
            }
            ChatMediaImageMemory.store(image, for: self.artifactId)
            withAnimation(self.reduceMotion ? nil : .easeOut(duration: 0.2)) {
                self.state = .loaded(image)
            }
            #else
            self.state = image.map(LoadState.loaded) ?? .unavailable
            #endif
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            self.state = .unavailable
        }
    }
}
