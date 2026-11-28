#if os(iOS)
import SwiftUI
import UIKit

/// The row of thumbnails at the foot of the image viewer, for a message (or a draft) with several
/// images: the current one ringed, a tap goes to that image, and the row follows a swipe.
struct ChatImageViewerFilmstrip: View {
    /// A 44 pt target around each thumbnail, which draws smaller so a ring fits around it.
    static let hitSize: CGFloat = 44
    static let thumbnailSize: CGFloat = 38
    static let thumbnailRadius: CGFloat = 9
    static let ringWidth: CGFloat = 2

    let chrome: ChatImageViewerChrome
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// A single image has no row.
    static func isShown(count: Int) -> Bool {
        count > 1
    }

    /// What VoiceOver reads for the thumbnail at `index`.
    static func accessibilityLabel(index: Int, count: Int) -> String {
        String(format: String(localized: "Image %lld of %lld"), Int64(index + 1), Int64(count))
    }

    var body: some View {
        let count = self.chrome.strip.count
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 0) {
                        ForEach(0..<count, id: \.self) { index in
                            self.thumbnail(index, count: count)
                                .id(index)
                        }
                    }
                    .padding(.horizontal, 16)
                    // Centered while the row fits; it scrolls once it does not.
                    .frame(minWidth: geometry.size.width)
                }
                .scrollBounceBehavior(.basedOnSize)
                .onAppear { proxy.scrollTo(self.chrome.stripIndex, anchor: .center) }
                .onChange(of: self.chrome.stripIndex) { _, index in
                    if self.reduceMotion {
                        proxy.scrollTo(index, anchor: .center)
                    } else {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(index, anchor: .center) }
                    }
                }
            }
        }
        .frame(height: Self.hitSize)
        .padding(.vertical, 8)
    }

    private func thumbnail(_ index: Int, count: Int) -> some View {
        let selected = index == self.chrome.stripIndex
        let shape = RoundedRectangle(cornerRadius: Self.thumbnailRadius, style: .continuous)
        return Button {
            self.chrome.selectStrip(index)
        } label: {
            ZStack {
                if let image = self.chrome.strip[index] {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    // The transcript skeleton's faint ink until a page brings the pixels.
                    OpenClawChatTheme.assistantText.opacity(0.07)
                }
            }
            .frame(width: Self.thumbnailSize, height: Self.thumbnailSize)
            .clipShape(shape)
            .frame(width: Self.hitSize, height: Self.hitSize)
            .overlay {
                if selected {
                    RoundedRectangle(
                        cornerRadius: Self.thumbnailRadius + (Self.hitSize - Self.thumbnailSize) / 2,
                        style: .continuous)
                        .strokeBorder(OpenClawChatTheme.assistantText, lineWidth: Self.ringWidth)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Self.accessibilityLabel(index: index, count: count))
        .accessibilityAddTraits(selected ? [.isImage, .isSelected] : .isImage)
        .accessibilityIdentifier("chat-image-viewer-thumbnail-\(index)")
    }
}
#endif
