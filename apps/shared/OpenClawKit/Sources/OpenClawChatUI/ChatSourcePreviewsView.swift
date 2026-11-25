import ImageIO
import SwiftUI

@MainActor
struct ChatSourcePreviewsView: View {
    let sources: [ChatSourcePreview]
    @State private var selectedSource: ChatSourcePreview?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(String(localized: "Sources"))
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(self.sources) { source in
                        Button {
                            self.selectedSource = source
                        } label: {
                            self.card(source)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(verbatim: "\(source.title), \(source.domain)"))
                        .accessibilityHint(String(localized: "Shows recorded source preview"))
                        .accessibilityIdentifier("chat-source-preview-card")
                        #if os(macOS)
                        .popover(isPresented: self.isSelected(source), arrowEdge: .bottom) {
                            ChatSourcePreviewDetail(source: source) { self.selectedSource = nil }
                                .frame(width: 320)
                        }
                        #endif
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
        }
        .accessibilityIdentifier("chat-source-previews")
        .onChange(of: self.sources) { _, sources in
            if let selected = self.selectedSource {
                self.selectedSource = sources.first { $0.id == selected.id }
            }
        }
        #if os(iOS)
        .sheet(item: self.$selectedSource) { source in
            ScrollView {
                ChatSourcePreviewDetail(source: source) { self.selectedSource = nil }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        #endif
    }

    private func card(_ source: ChatSourcePreview) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: source.title)
                .font(OpenClawChatTypography.footnoteSemiBold)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 5) {
                ChatSourceFavicon(host: source.domain)
                Text(verbatim: source.domain)
                    .font(OpenClawChatTypography.caption2)
                    .lineLimit(1)
            }
            .foregroundStyle(.secondary)
        }
        .padding(10)
        .frame(width: 184, alignment: .leading)
        .frame(minHeight: 74, alignment: .topLeading)
        .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.primary.opacity(0.12), lineWidth: 0.5))
        .contentShape(RoundedRectangle(cornerRadius: 10))
    }

    #if os(macOS)
    private func isSelected(_ source: ChatSourcePreview) -> Binding<Bool> {
        Binding(
            get: { self.selectedSource?.id == source.id },
            set: { if !$0 { self.selectedSource = nil } })
    }
    #endif
}

private struct ChatSourcePreviewDetail: View {
    let source: ChatSourcePreview
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(verbatim: self.source.domain)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: self.dismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(String(localized: "Close source preview"))
            }
            Text(verbatim: self.source.title)
                .font(OpenClawChatTypography.headline)
                .fixedSize(horizontal: false, vertical: true)
            if let excerpt = self.source.excerpt {
                Text(self.source.excerptKind == .page
                    ? String(localized: "Page excerpt")
                    : String(localized: "Search snippet"))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(.secondary)
                Text(verbatim: excerpt)
                    .font(OpenClawChatTypography.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            } else {
                Text(String(localized: "No recorded excerpt available."))
                    .font(OpenClawChatTypography.callout)
                    .foregroundStyle(.secondary)
            }
            Link(destination: self.source.url) {
                Label {
                    Text(String(localized: "Open source"))
                        .font(OpenClawChatTypography.footnoteSemiBold)
                } icon: {
                    Image(systemName: "arrow.up.right")
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("chat-source-preview-detail")
    }
}

/// The only source view that reads the source context, so a context refresh restarts favicon loads
/// without re-running the rows that hold the cards.
@MainActor
private struct ChatSourceFavicon: View {
    @Environment(\.openClawChatGateway) private var gateway
    let host: String
    @State private var image: CGImage?

    private struct RequestIdentity: Hashable {
        let host: String
        let context: OpenClawChatSourceContext?
    }

    var body: some View {
        let context = self.gateway?.faviconContext()
        Group {
            if context != nil, let image {
                Image(decorative: image, scale: 1)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "globe")
                    .font(.system(size: 12))
            }
        }
        .frame(width: 14, height: 14)
        .accessibilityHidden(true)
        .task(id: RequestIdentity(host: self.host, context: context)) {
            self.image = nil
            guard context != nil, let data = await self.gateway?.loadFavicon(self.host), !Task.isCancelled,
                  data.count <= 256 * 1024,
                  let source = CGImageSourceCreateWithData(data as CFData, nil)
            else { return }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 32,
            ]
            self.image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
        }
    }
}
