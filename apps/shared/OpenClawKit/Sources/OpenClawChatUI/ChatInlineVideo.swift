#if os(iOS)
import AVFoundation
import AVKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

extension EnvironmentValues {
    @Entry var chatInlineVideos: ChatInlineVideos?
}

/// Local uploads stay tied to their send, not to a potentially reused file name. Reconciliation
/// keeps the same user idempotency key. Eviction simply restores the original file card.
@MainActor @Observable
final class ChatInlineVideos {
    final class Sent {
        let attachment: OpenClawPendingAttachment
        init(_ attachment: OpenClawPendingAttachment) {
            self.attachment = attachment
        }
    }

    @ObservationIgnored private let sent = NSCache<NSString, Sent>()
    @ObservationIgnored let posters = NSCache<NSString, UIImage>()
    private(set) var activeRow: UUID?
    private(set) var player: ChatMediaVideoPlayer?

    init() {
        self.sent.totalCostLimit = 48 * 1024 * 1024
        self.posters.totalCostLimit = 16 * 1024 * 1024
    }

    func remember(_ attachments: [OpenClawPendingAttachment], messageKey: String) {
        for (index, attachment) in attachments.filter({ $0.mimeType.hasPrefix("video/") }).enumerated() {
            guard let poster = attachment.preview else { continue }
            let cost = attachment.data.count + Int(poster.size.width * poster.size.height * 4)
            self.sent.setObject(Sent(attachment), forKey: "\(messageKey):\(index)" as NSString, cost: cost)
        }
    }

    func attachment(messageKey: String?, index: Int) -> OpenClawPendingAttachment? {
        guard let messageKey else { return nil }
        return self.sent.object(forKey: "\(messageKey):\(index)" as NSString)?.attachment
    }

    func play(row: UUID, url: URL, title: String, allowed: @escaping @MainActor @Sendable () -> Bool) {
        self.player?.cleanup()
        self.player = ChatMediaVideoPlayer(url: url, title: title, playbackAllowed: allowed)
        self.activeRow = row
        self.player?.play()
    }

    func stop(row: UUID) {
        guard row == self.activeRow else { return }
        self.player?.cleanup()
        self.player = nil
        self.activeRow = nil
    }
}

struct ChatInlineVideoSource {
    let size: CGSize
    let duration: Double?
    let local: OpenClawPendingAttachment?
    let artifactID: String?

    init?(_ content: OpenClawChatMessageContent, local: OpenClawPendingAttachment?) {
        guard content.mediaKind == .video else { return nil }
        let id = content.artifactId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.artifactID = OpenClawChatMediaKind.video.acceptsManagedArtifactID(id) ? id : nil
        // Inbound references are not managed artifacts. iOS only has an inbound image loader.
        guard local != nil || self.artifactID != nil else { return nil }
        if let w = content.width, let h = content.height, w > 0, h > 0 {
            size = CGSize(width: w, height: h)
        } else if let size = local?.videoPixelSize, size.width > 0, size.height > 0 {
            self.size = size
        } else {
            return nil
        }
        self.local = local
        self.duration = content.durationSeconds ?? local?.durationSeconds
    }
}

@MainActor
struct ChatInlineVideo<Fallback: View>: View {
    let source: ChatInlineVideoSource
    let title: String
    let maxWidth: CGFloat
    let resolverReady: Bool
    let playbackAllowed: @MainActor @Sendable () -> Bool
    let load: ChatMediaPlaybackLoader.Load
    @ViewBuilder let fallback: () -> Fallback

    @Environment(\.chatInlineVideos) private var videos
    @Environment(\.scenePhase) private var scenePhase
    @State private var row = UUID()
    @State private var poster: UIImage?
    @State private var file: ChatDownloadedFile?
    @State private var assetDuration: Double?
    @State private var failed = false
    @State private var playIntent: Int?

    var body: some View {
        let image = self.source.local?.preview ?? self.poster
        let active = self.videos?.activeRow == self.row ? self.videos?.player : nil
        let shape = RoundedRectangle(cornerRadius: ChatImageViewerThumbnail.cornerRadius, style: .continuous)
        return ChatImageBox(pixelSize: self.source.size, maxWidth: self.maxWidth) {
            ZStack {
                if self.failed || active?.isUnavailable == true {
                    self.fallback()
                } else {
                    shape.fill(OpenClawChatTheme.assistantText.opacity(0.07))
                    if let active {
                        ChatInlineSystemPlayer(player: active.player)
                        if active.isPlaybackBlocked {
                            Text(String(localized: "Pause Talk mode before playing this attachment."))
                                .font(OpenClawChatTypography.caption)
                                .padding(6)
                                .background(.regularMaterial)
                        }
                    } else if let image {
                        Button {
                            self.playIntent = ChatMediaPlaybackCoordinator.shared.claimPlaybackIntent()
                        } label: {
                            Image(uiImage: image).resizable().scaledToFill()
                                .overlay(alignment: .bottomTrailing) { self.durationLabel }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(localized: "Play video"))
                        .accessibilityValue(self.clock ?? "")
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(shape)
        }
        .task(id: self.resolverReady) { await self.preparePoster() }
        .task(id: self.playIntent) { await self.startPlayback() }
        .onDisappear { self.stop() }
        .onScrollVisibilityChange(threshold: 0.01) { visible in
            if !visible {
                self.stop()
            }
        }
        .onChange(of: self.scenePhase) { _, phase in
            if phase == .background {
                self.stop()
            }
        }
    }

    private var clock: String? {
        guard let seconds = source.duration ?? assetDuration, seconds.isFinite, seconds >= 0 else { return nil }
        return Duration.seconds(seconds.rounded(.down)).formatted(
            .time(pattern: seconds < 3600 ? .minuteSecond : .hourMinuteSecond))
    }

    @ViewBuilder private var durationLabel: some View {
        if let clock {
            Text(verbatim: clock)
                .font(OpenClawChatTypography.caption2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.9), radius: 1, y: 0.5)
                .padding(7)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "play.fill")
                .font(.caption2)
                .foregroundStyle(.white)
                .shadow(color: .black, radius: 1)
                .padding(7)
                .accessibilityHidden(true)
        }
    }

    private func stop() {
        self.playIntent = nil
        self.videos?.stop(row: self.row)
    }

    private func preparePoster() async {
        guard self.source.local?.preview == nil else { return }
        guard self.resolverReady else {
            self.stop()
            self.failed = true
            return
        }
        self.failed = false
        guard self.poster == nil else { return }
        if let id = self.source.artifactID, self.source.duration != nil,
           let poster = self.videos?.posters.object(forKey: id as NSString)
        {
            self.poster = poster
            return
        }
        do {
            let url = try await playbackURL()
            let asset = AVURLAsset(url: url)
            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1080, height: 1080)
            let frame = try await generator.image(at: .zero).image
            if self.source.duration == nil {
                self.assetDuration = try await asset.load(.duration).seconds
            }
            try Task.checkCancellation()
            let poster = UIImage(cgImage: frame)
            self.poster = poster
            if let id = self.source.artifactID {
                self.videos?.posters.setObject(poster, forKey: id as NSString, cost: frame.bytesPerRow * frame.height)
            }
        } catch {
            if !Task.isCancelled {
                self.failed = true
            }
        }
    }

    private func startPlayback() async {
        guard let intent = playIntent else { return }
        do {
            let url = try await playbackURL()
            try Task.checkCancellation()
            guard ChatMediaPlaybackCoordinator.shared.isCurrentIntent(intent) else { return }
            self.videos?.play(row: self.row, url: url, title: self.title, allowed: self.playbackAllowed)
        } catch {
            if !Task.isCancelled {
                self.failed = true
            }
        }
    }

    /// The managed route already chooses a range-readable stream when allowed, or a bounded
    /// authenticated download otherwise. Reuse downloaded bytes; obtain a fresh stream ticket on tap.
    private func playbackURL() async throws -> URL {
        if let file {
            return file.url
        }
        let media: OpenClawChatMediaData
        if let local = source.local {
            media = OpenClawChatMediaData(data: local.data, mimeType: local.mimeType)
        } else {
            switch try await ChatMediaPlaybackLoader.load(request: self.load, onPreparing: {}) {
            case let .stream(stream): return stream.url
            case let .data(data): media = data
            default: throw URLError(.cannotDecodeContentData)
            }
        }
        guard media.mimeType.hasPrefix("video/") else { throw URLError(.cannotDecodeContentData) }
        let file = try await Task.detached(priority: .userInitiated) {
            let ext = UTType(mimeType: media.mimeType)?.preferredFilenameExtension ?? "mp4"
            return try ChatDownloadedFile(data: media.data, fileName: "video.\(ext)")
        }.value
        try Task.checkCancellation()
        self.file = file
        return file.url
    }
}

private struct ChatInlineSystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context _: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = self.player
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context _: Context) {
        if controller.player !== self.player {
            controller.player = self.player
        }
    }
}
#endif
