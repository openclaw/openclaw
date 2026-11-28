#if os(iOS)
import SwiftUI
import UIKit

/// The complete gallery is metadata; only the first three cards acquire pixels in the transcript.
struct ChatMessagePhotoAlbum {
    struct Page {
        let item: ChatImageViewerItem
        let content: OpenClawChatMessageContent
    }

    let pages: [Page]

    init?(_ attachments: [OpenClawChatMessageContent], sentPhotos: Bool) {
        guard attachments.count >= 5 else { return nil }
        let pages = attachments.compactMap { attachment in
            ChatImageViewerItem.gallery(in: [attachment], sentPhotos: sentPhotos).first.map {
                Page(item: $0, content: attachment)
            }
        }
        guard pages.count >= 5 else { return nil }
        self.pages = pages
    }
}

struct ChatMessagePhotoStack: View {
    @Environment(\.openClawChatGateway) private var gateway
    @Environment(\.openClawChatColumn) private var column
    @State private var previews: [String: UIImage] = [:]
    let album: ChatMessagePhotoAlbum

    /// Back cards turn the same way and peek only above and past the trailing edge of the cover,
    /// so the stack reads as one object leaning into the bubble's side.
    static let cards: [(angle: Double, offset: CGSize)] = [
        (0, .zero),
        (2, CGSize(width: 5, height: -6)),
        (4, CGSize(width: 9, height: -10)),
    ]
    /// Room the back cards take outside the cover; the layout reserves it so nothing overlaps.
    static let peek: CGFloat = 16

    var body: some View {
        let side = min(176, self.column.bubbleAndMediaMaxWidth - Self.peek)
        let ready = self.gateway?.isResolverReady() == true
        let label = String(format: String(localized: "%lld images"), Int64(self.album.pages.count))
        let shape = RoundedRectangle(cornerRadius: ChatImageViewerThumbnail.cornerRadius, style: .continuous)
        Button {
            self.openGallery()
        } label: {
            ZStack(alignment: .bottomLeading) {
                ForEach([2, 1, 0], id: \.self) { index in
                    let page = self.album.pages[index]
                    let id = page.item.artifactId
                    let card = Self.cards[index]
                    ChatImageViewerThumbnail(image: self.previews[id], artifactId: id, fillsProposal: true)
                        .frame(width: side, height: side)
                        .background(OpenClawChatTheme.assistantText.opacity(0.07), in: shape)
                        .background(Color(uiColor: OpenClawChatTheme.canvasUIColor), in: shape)
                        .overlay(shape.strokeBorder(.primary.opacity(index == 0 ? 0.1 : 0.16), lineWidth: 1))
                        // Separates each card from the one behind it, not from the canvas.
                        .shadow(color: .black.opacity(index == 2 ? 0 : 0.18), radius: 3, y: 1)
                        .rotationEffect(.degrees(card.angle))
                        .offset(card.offset)
                        .task(id: "\(id):\(ready)") { await self.loadPreview(page, ready: ready) }
                }
                Text(label)
                    .font(OpenClawChatTypography.footnote.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(.black.opacity(0.55), in: Capsule())
                    .padding(10)
            }
            .padding(.trailing, Self.peek)
            .padding(.top, Self.peek)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityHint(String(localized: "Opens the image full screen."))
    }

    private func loadPreview(_ page: ChatMessagePhotoAlbum.Page, ready: Bool) async {
        let id = page.item.artifactId
        guard self.previews[id] == nil,
              let preview = await Self.preview(page, gateway: ready ? self.gateway : nil),
              !Task.isCancelled
        else { return }
        self.previews[id] = preview
    }

    /// A card-sized rendition: the bytes the phone holds, else the Gateway's smallest one.
    private static func preview(
        _ page: ChatMessagePhotoAlbum.Page,
        gateway: ChatGatewayResources?) async -> UIImage?
    {
        let media: OpenClawChatMediaData? = if let local = ChatUserImageSource(page.content)?.local {
            local
        } else {
            try? await gateway?.loadImageThumbnail(page.item.artifactId)
        }
        guard let media, !Task.isCancelled else { return nil }
        return await Task.detached(priority: .userInitiated) {
            ChatMediaImageDecoder.decode(media.data, maxPixelSize: 480)
        }.value
    }

    private func openGallery() {
        let pages = self.album.pages
        let id = pages[0].item.artifactId
        ChatImageViewerController.present(
            items: pages.map(\.item),
            artifactId: id,
            thumbnail: self.previews[id],
            thumbnails: self.previews,
            usesReducedThumbnails: true,
            // Every page closes back into the cover: the cards behind it are partly hidden and
            // later pages have no card at all.
            zoomSourceID: id,
            stripLoad: { [gateway] id in
                guard let page = pages.first(where: { $0.item.artifactId == id }) else { return nil }
                return await Self.preview(page, gateway: gateway?.isResolverReady() == true ? gateway : nil)
            },
            load: { [gateway] id in
                if let page = pages.first(where: { $0.item.artifactId == id }),
                   let local = ChatUserImageSource(page.content)?.local { return .data(local) }
                return try await gateway?.loadMedia(id, .image, .native)
            })
    }
}
#endif
