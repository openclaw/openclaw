import AVFoundation
import AVKit
import Foundation
import Observation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct ChatMediaVideoAttachment: View {
    private enum LoadState {
        case loading
        case preparing
        case loaded(ChatMediaVideoPlayer)
        case unavailable
    }

    let artifactId: String
    let label: String
    let width: Int?
    let height: Int?
    let resolverReady: Bool
    let playbackAllowed: @MainActor @Sendable () -> Bool
    let load: @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?

    @State private var state: LoadState = .loading
    @State private var retryGeneration = 0

    var body: some View {
        Group {
            switch self.state {
            case .loading:
                self.waitingCard(String(localized: "Loading video…"))
            case .preparing:
                self.waitingCard(String(localized: "Preparing playback…"))
            case let .loaded(player):
                self.playerCard(player)
            case .unavailable:
                self.unavailableCard
            }
        }
        .task(id: "\(self.artifactId):\(self.resolverReady):\(self.retryGeneration)") {
            await self.loadVideo()
        }
        .onDisappear {
            if case let .loaded(player) = self.state {
                player.cleanup()
            }
        }
    }

    private func waitingCard(_ message: String) -> some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(message)
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(minHeight: self.reservedHeight)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func playerCard(_ player: ChatMediaVideoPlayer) -> some View {
        if player.isUnavailable {
            self.unavailableCard
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ZStack {
                    VideoPlayer(player: player.player)
                    if !player.isPlaying {
                        Button {
                            player.play()
                        } label: {
                            ZStack {
                                Color.clear
                                    .contentShape(Rectangle())
                                Image(systemName: "play.circle.fill")
                                    .font(.system(size: 46))
                                    .symbolRenderingMode(.hierarchical)
                                    .foregroundStyle(.white)
                                    .shadow(radius: 4)
                            }
                        }
                        .buttonStyle(.plain)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .accessibilityLabel(String(localized: "Play video"))
                    }
                }
                .aspectRatio(self.aspectRatio, contentMode: .fit)
                .frame(maxHeight: 360)
                .background(Color.black)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
                .accessibilityLabel(self.label)

                if player.isPlaybackBlocked {
                    Text(String(localized: "Pause Talk mode before playing this attachment."))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var unavailableCard: some View {
        ChatMediaUnavailableRow(
            systemImage: "video.badge.exclamationmark",
            message: String(localized: "Video unavailable"),
            minimumHeight: self.reservedHeight)
        {
            self.retryGeneration &+= 1
        }
    }

    private var aspectRatio: CGFloat {
        guard let width, let height, width > 0, height > 0 else { return 16 / 9 }
        return CGFloat(width) / CGFloat(height)
    }

    private var reservedHeight: CGFloat {
        min(320, max(120, 320 / self.aspectRatio))
    }

    private func loadVideo() async {
        if case let .loaded(player) = self.state {
            player.cleanup()
        }
        guard self.resolverReady else {
            self.state = .unavailable
            return
        }
        self.state = .loading
        do {
            let loaded = try await ChatMediaPlaybackLoader.load(
                request: { try await self.load(self.artifactId) },
                onPreparing: { self.state = .preparing })
            guard let loaded, !Task.isCancelled else {
                if !Task.isCancelled { self.state = .unavailable }
                return
            }
            let player = try await ChatMediaVideoPlayer(
                loaded: loaded,
                title: self.label,
                playbackAllowed: self.playbackAllowed)
            guard !Task.isCancelled else {
                player.cleanup()
                return
            }
            self.state = .loaded(player)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            self.state = .unavailable
        }
    }
}

@MainActor
@Observable
final class ChatMediaVideoPlayer: ChatMediaPlayer {
    let player: AVPlayer
    private(set) var isPlaying = false
    private(set) var isPlaybackBlocked = false
    private(set) var isUnavailable = false

    @ObservationIgnored private let playbackAllowed: @MainActor @Sendable () -> Bool
    @ObservationIgnored private let title: String
    @ObservationIgnored private let temporaryFileURL: URL?
    @ObservationIgnored private var statusTask: Task<Void, Never>?
    @ObservationIgnored private var rateObserver: (any NSObjectProtocol)?
    @ObservationIgnored private let playbackCoordinator: ChatMediaPlaybackCoordinator

    init(
        loaded: OpenClawChatLoadedMedia,
        title: String,
        playbackAllowed: @escaping @MainActor @Sendable () -> Bool,
        playbackCoordinator: ChatMediaPlaybackCoordinator = .shared) async throws
    {
        let playbackURL: URL
        let temporaryFileURL: URL?
        switch loaded {
        case let .stream(stream):
            playbackURL = stream.url
            temporaryFileURL = nil
        case let .data(media):
            guard media.mimeType.lowercased().hasPrefix("video/") else {
                throw ChatMediaVideoError.unsupportedMediaType
            }
            let fileURL = try await Self.writeTemporaryVideo(media)
            playbackURL = fileURL
            temporaryFileURL = fileURL
        case .preparing:
            throw ChatMediaVideoError.playbackStillPreparing
        }
        self.player = AVPlayer(url: playbackURL)
        self.title = title
        self.playbackAllowed = playbackAllowed
        self.temporaryFileURL = temporaryFileURL
        self.playbackCoordinator = playbackCoordinator
        self.observePlaybackActions()
        self.startStatusUpdates()
    }

    func play() {
        guard self.playbackAllowed() else {
            self.isPlaybackBlocked = true
            return
        }
        self.isPlaybackBlocked = false
        self.playbackCoordinator.activate(self)
        self.rewindIfFinished()
        self.player.play()
        self.isPlaying = true
        self.playbackCoordinator.updateNowPlaying(self)
    }

    func pause() {
        self.playbackCoordinator.playbackDidPause(self)
        self.player.pause()
        self.isPlaying = false
        self.playbackCoordinator.updateNowPlaying(self)
    }

    var nowPlayingMetadata: ChatMediaNowPlayingMetadata {
        let duration = self.player.currentItem?.duration.seconds ?? 0
        let elapsed = self.player.currentTime().seconds
        return ChatMediaNowPlayingMetadata(
            title: self.title,
            duration: duration.isFinite && duration > 0 ? duration : 0,
            elapsed: elapsed.isFinite && elapsed > 0 ? elapsed : 0,
            playbackRate: self.isPlaying ? 1 : 0)
    }

    func cleanup() {
        if let rateObserver {
            NotificationCenter.default.removeObserver(rateObserver)
            self.rateObserver = nil
        }
        self.statusTask?.cancel()
        self.statusTask = nil
        self.player.pause()
        self.player.replaceCurrentItem(with: nil)
        self.isPlaying = false
        self.playbackCoordinator.release(self)
        if let temporaryFileURL {
            try? FileManager.default.removeItem(at: temporaryFileURL)
        }
    }

    private func observePlaybackActions() {
        let reasonKey = AVPlayer.rateDidChangeReasonKey
        let explicitRateChange = AVPlayer.RateDidChangeReason.setRateCalled.rawValue
        self.rateObserver = NotificationCenter.default.addObserver(
            forName: AVPlayer.rateDidChangeNotification,
            object: self.player,
            queue: .main)
        { [weak self] notification in
            // AVKit's controls change AVPlayer directly, bypassing our methods.
            // Buffering and natural completion are not explicit set-rate actions.
            guard notification.userInfo?[reasonKey] as? String == explicitRateChange else { return }
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.player.rate == 0 {
                    self.playbackCoordinator.playbackDidPause(self)
                } else if self.playbackAllowed() {
                    self.playbackCoordinator.activate(self)
                } else {
                    self.isPlaybackBlocked = true
                    self.player.pause()
                }
            }
        }
    }

    private func startStatusUpdates() {
        self.statusTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, !Task.isCancelled else { return }
                if self.player.error != nil || self.player.currentItem?.status == .failed {
                    self.fail()
                    return
                }
                let playing = self.player.timeControlStatus == .playing
                let ownsPlayback = self.playbackCoordinator.isActive(self)
                if playing || ownsPlayback, !self.playbackAllowed() {
                    self.player.pause()
                    self.isPlaybackBlocked = true
                    self.isPlaying = false
                    self.playbackCoordinator.release(self)
                    continue
                }
                if playing, !ownsPlayback {
                    guard self.playbackAllowed() else {
                        self.player.pause()
                        self.isPlaybackBlocked = true
                        self.isPlaying = false
                        continue
                    }
                    self.isPlaybackBlocked = false
                    self.playbackCoordinator.activate(self)
                } else if !playing, self.isPlaying {
                    if self.rewindIfFinished() {
                        self.playbackCoordinator.release(self)
                    }
                }
                self.isPlaying = playing
                self.playbackCoordinator.updateNowPlaying(self)
            }
        }
    }

    @discardableResult
    private func rewindIfFinished() -> Bool {
        guard let item = self.player.currentItem else { return false }
        let duration = item.duration.seconds
        let currentTime = self.player.currentTime().seconds
        guard duration.isFinite, duration > 0, currentTime.isFinite,
              currentTime >= duration - 0.05
        else { return false }
        self.player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
        return true
    }

    private func fail() {
        self.statusTask?.cancel()
        self.statusTask = nil
        self.player.pause()
        self.isPlaying = false
        self.isUnavailable = true
        self.playbackCoordinator.release(self)
    }

    private nonisolated static func writeTemporaryVideo(
        _ media: OpenClawChatMediaData) async throws -> URL
    {
        try await Task.detached(priority: .userInitiated) {
            let fileExtension = UTType(mimeType: media.mimeType)?.preferredFilenameExtension ?? "mp4"
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("openclaw-chat-video-\(UUID().uuidString)")
                .appendingPathExtension(fileExtension)
            try media.data.write(to: url, options: [.atomic])
            return url
        }.value
    }
}

private enum ChatMediaVideoError: Error {
    case unsupportedMediaType
    case playbackStillPreparing
}
