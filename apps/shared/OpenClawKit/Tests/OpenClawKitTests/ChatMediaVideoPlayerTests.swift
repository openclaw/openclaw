import AVFoundation
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
@Suite("Native video playback intent")
struct ChatMediaVideoPlayerTests {
    @Test func `native pause supersedes a pending audio load without waiting for status polling`() async throws {
        let url = try self.silentClip(duration: 2)
        defer { try? FileManager.default.removeItem(at: url) }
        let coordinator = ChatMediaPlaybackCoordinator()
        let video = try await ChatMediaVideoPlayer(
            loaded: .stream(OpenClawChatMediaStream(url: url)),
            title: "Silent test clip",
            playbackAllowed: { true },
            playbackCoordinator: coordinator)
        defer { video.cleanup() }
        video.play()
        try await self.waitUntil { video.player.timeControlStatus == .playing }
        let audioIntent = coordinator.claimPlaybackIntent()

        // AVKit changes the underlying player directly, not video.pause().
        video.player.pause()

        #expect(!coordinator.isCurrentIntent(audioIntent))
        #expect(coordinator.isActive(video))
    }

    @Test func `native play supersedes a pending audio load while video still owns playback`() async throws {
        let url = try self.silentClip(duration: 2)
        defer { try? FileManager.default.removeItem(at: url) }
        let coordinator = ChatMediaPlaybackCoordinator()
        let video = try await ChatMediaVideoPlayer(
            loaded: .stream(OpenClawChatMediaStream(url: url)),
            title: "Silent test clip",
            playbackAllowed: { true },
            playbackCoordinator: coordinator)
        defer { video.cleanup() }
        video.play()
        video.player.pause()
        let audioIntent = coordinator.claimPlaybackIntent()

        video.player.play()

        #expect(!coordinator.isCurrentIntent(audioIntent))
        #expect(coordinator.isActive(video))
    }

    @Test func `waiting for a video item does not count as a pause action`() async throws {
        let url = try self.silentClip(duration: 2)
        defer { try? FileManager.default.removeItem(at: url) }
        let coordinator = ChatMediaPlaybackCoordinator()
        let video = try await ChatMediaVideoPlayer(
            loaded: .stream(OpenClawChatMediaStream(url: url)),
            title: "Silent test clip",
            playbackAllowed: { true },
            playbackCoordinator: coordinator)
        defer { video.cleanup() }
        video.player.replaceCurrentItem(with: nil)
        video.play()
        let audioIntent = coordinator.claimPlaybackIntent()

        #expect(video.player.timeControlStatus == .waitingToPlayAtSpecifiedRate)
        #expect(video.player.reasonForWaitingToPlay == .noItemToPlay)
        #expect(coordinator.isCurrentIntent(audioIntent))
    }

    @Test func `natural completion does not supersede a pending audio load`() async throws {
        let url = try self.silentClip(duration: 0.3)
        defer { try? FileManager.default.removeItem(at: url) }
        let coordinator = ChatMediaPlaybackCoordinator()
        let video = try await ChatMediaVideoPlayer(
            loaded: .stream(OpenClawChatMediaStream(url: url)),
            title: "Silent test clip",
            playbackAllowed: { true },
            playbackCoordinator: coordinator)
        defer { video.cleanup() }
        video.play()
        try await self.waitUntil { video.player.timeControlStatus == .playing }
        let audioIntent = coordinator.claimPlaybackIntent()

        try await self.waitUntil { video.player.rate == 0 }

        #expect(coordinator.isCurrentIntent(audioIntent))
    }

    private func silentClip(duration: Double) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).caf")
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 1))
        let frames = AVAudioFrameCount(duration * format.sampleRate)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try #require(buffer.floatChannelData)
        samples[0].initialize(repeating: 0, count: Int(frames))
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        try file.write(from: buffer)
        return url
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(condition())
    }
}
