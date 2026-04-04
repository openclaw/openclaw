import AVFoundation
import Foundation
import OSLog

@MainActor
protocol TalkAudioPlayable: AnyObject {
    var delegate: AVAudioPlayerDelegate? { get set }
    var isPlaying: Bool { get }
    var duration: TimeInterval { get }
    var currentTime: TimeInterval { get }

    @discardableResult func prepareToPlay() -> Bool
    @discardableResult func play() -> Bool
    func stop()
}

private final class AVAudioPlayerWrapper: TalkAudioPlayable {
    private let base: AVAudioPlayer

    init(data: Data) throws {
        self.base = try AVAudioPlayer(data: data)
    }

    var delegate: AVAudioPlayerDelegate? {
        get { self.base.delegate }
        set { self.base.delegate = newValue }
    }

    var isPlaying: Bool { self.base.isPlaying }
    var duration: TimeInterval { self.base.duration }
    var currentTime: TimeInterval { self.base.currentTime }

    @discardableResult
    func prepareToPlay() -> Bool {
        self.base.prepareToPlay()
    }

    @discardableResult
    func play() -> Bool {
        self.base.play()
    }

    func stop() {
        self.base.stop()
    }
}

@MainActor
final class TalkAudioPlayer: NSObject, @preconcurrency AVAudioPlayerDelegate {
    static let shared = TalkAudioPlayer()

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.tts")
    private var playerFactory: (Data) throws -> any TalkAudioPlayable = { data in
        try AVAudioPlayerWrapper(data: data)
    }
    private var player: (any TalkAudioPlayable)?
    private var playback: Playback?

    private enum WatchdogDecision {
        case stop
        case waitForCompletion(timeoutSeconds: Double)
    }

    private final class Playback: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private var continuation: CheckedContinuation<TalkPlaybackResult, Never>?
        private var watchdog: Task<Void, Never>?

        func setContinuation(_ continuation: CheckedContinuation<TalkPlaybackResult, Never>) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.continuation = continuation
        }

        func setWatchdog(_ task: Task<Void, Never>?) {
            self.lock.lock()
            let old = self.watchdog
            self.watchdog = task
            self.lock.unlock()
            old?.cancel()
        }

        func cancelWatchdog() {
            self.setWatchdog(nil)
        }

        func finish(_ result: TalkPlaybackResult) {
            let continuation: CheckedContinuation<TalkPlaybackResult, Never>?
            self.lock.lock()
            if self.finished {
                continuation = nil
            } else {
                self.finished = true
                continuation = self.continuation
                self.continuation = nil
            }
            self.lock.unlock()
            continuation?.resume(returning: result)
        }
    }

    func play(data: Data) async -> TalkPlaybackResult {
        self.stopInternal()

        let playback = Playback()
        self.playback = playback

        return await withCheckedContinuation { continuation in
            playback.setContinuation(continuation)
            do {
                let player = try self.playerFactory(data)
                self.player = player

                player.delegate = self
                player.prepareToPlay()

                self.armWatchdog(playback: playback)

                let ok = player.play()
                if !ok {
                    self.logger.error("talk audio player refused to play")
                    self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
                }
            } catch {
                self.logger.error("talk audio player failed: \(error.localizedDescription, privacy: .public)")
                self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
            }
        }
    }

    func installPlayerFactoryForTesting(_ factory: @escaping (Data) throws -> any TalkAudioPlayable) {
        self.playerFactory = factory
    }

    func resetPlayerFactoryForTesting() {
        self.playerFactory = { data in
            try AVAudioPlayerWrapper(data: data)
        }
    }

    func stop() -> Double? {
        let time = self.player?.currentTime
        if self.playback != nil {
            self.stopInternal(interruptedAt: time)
        } else {
            self.player?.stop()
            self.player = nil
        }
        return time
    }

    func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully flag: Bool) {
        self.stopInternal(finished: flag)
    }

    func audioPlayerDecodeErrorDidOccur(_: AVAudioPlayer, error: Error?) {
        if let error {
            self.logger.error("talk audio player decode error: \(error.localizedDescription, privacy: .public)")
        } else {
            self.logger.error("talk audio player decode error")
        }
        self.stopInternal(finished: false)
    }

    private func stopInternal(finished: Bool = false, interruptedAt: Double? = nil) {
        guard let playback else { return }
        let result = TalkPlaybackResult(finished: finished, interruptedAt: interruptedAt)
        self.finish(playback: playback, result: result)
    }

    private func finish(playback: Playback, result: TalkPlaybackResult) {
        playback.cancelWatchdog()
        playback.finish(result)

        guard self.playback === playback else { return }
        self.playback = nil
        self.player?.stop()
        self.player = nil
    }

    private func stopInternal() {
        if let playback = self.playback {
            let interruptedAt = self.player?.currentTime
            self.finish(
                playback: playback,
                result: TalkPlaybackResult(finished: false, interruptedAt: interruptedAt))
            return
        }
        self.player?.stop()
        self.player = nil
    }

    private func armWatchdog(playback: Playback) {
        playback.setWatchdog(Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: 650_000_000)
            } catch {
                return
            }
            if Task.isCancelled { return }

            let decision = await MainActor.run { [weak self] () -> WatchdogDecision in
                guard let self else { return .stop }
                guard self.playback === playback else { return .stop }
                guard self.player?.isPlaying == true else {
                    self.logger.error("talk audio player stopped before delegate completion")
                    self.finish(playback: playback, result: self.resultForStoppedPlayback())
                    return .stop
                }

                let duration = self.player?.duration ?? 0
                let timeoutSeconds = min(max(2.0, duration + 2.0), 5 * 60.0)
                return .waitForCompletion(timeoutSeconds: timeoutSeconds)
            }
            guard case let .waitForCompletion(timeoutSeconds) = decision else { return }

            do {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            } catch {
                return
            }
            if Task.isCancelled { return }

            await MainActor.run { [weak self] in
                guard let self else { return }
                guard self.playback === playback else { return }
                guard self.player?.isPlaying == true else {
                    self.finish(playback: playback, result: self.resultForStoppedPlayback())
                    return
                }
                self.logger.error("talk audio player watchdog fired")
                self.finish(
                    playback: playback,
                    result: TalkPlaybackResult(finished: false, interruptedAt: nil))
            }
        })
    }

    private func resultForStoppedPlayback() -> TalkPlaybackResult {
        let currentTime = self.player?.currentTime
        let duration = self.player?.duration ?? 0
        let tolerance = max(0.05, duration * 0.1)
        let finished = (currentTime ?? 0) + tolerance >= duration && duration > 0
        return TalkPlaybackResult(
            finished: finished,
            interruptedAt: finished ? nil : currentTime)
    }
}

struct TalkPlaybackResult {
    let finished: Bool
    let interruptedAt: Double?
}
