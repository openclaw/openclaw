import AVFoundation
import Foundation
import OSLog

@MainActor
final class TalkAudioPlayer: NSObject, @preconcurrency AVAudioPlayerDelegate {
    static let shared = TalkAudioPlayer()

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.tts")
    private var player: AVAudioPlayer?
    private var playback: Playback?

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
                let player = try AVAudioPlayer(data: data)
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

    func stop() -> Double? {
        guard let player else { return nil }
        let time = player.currentTime
        self.stopInternal(interruptedAt: time)
        return time
    }

    func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully flag: Bool) {
        self.stopInternal(finished: flag)
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
        playback.setWatchdog(Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: 650_000_000)
            } catch {
                return
            }
            if Task.isCancelled { return }

            guard self.playback === playback else { return }
            if self.player?.isPlaying != true {
                self.logger.error("talk audio player did not start playing")
                self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
                return
            }

            let duration = self.player?.duration ?? 0
            let timeoutSeconds = min(max(2.0, duration + 2.0), 5 * 60.0)
            do {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            } catch {
                return
            }
            if Task.isCancelled { return }

            guard self.playback === playback else { return }
            guard self.player?.isPlaying == true else { return }
            self.logger.error("talk audio player watchdog fired")
            self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
        })
    }
}

struct TalkPlaybackResult {
    let finished: Bool
    let interruptedAt: Double?
}

// MARK: - Streaming Audio Player

/// Plays audio chunks in sequence for streaming TTS
@MainActor
final class TalkStreamingAudioPlayer: NSObject, @preconcurrency AVAudioPlayerDelegate {
    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.streaming")
    private var audioEngine: AVAudioEngine?
    private var playerNode: AVAudioPlayerNode?
    private var currentFormat: AVAudioFormat?
    private var isPlaying = false
    private var isStopped = false
    private var lastBufferCompleted = true
    private var buffersScheduled = 0
    private var buffersCompleted = 0
    
    override init() {
        super.init()
        setupAudioEngine()
    }
    
    private func setupAudioEngine() {
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        
        engine.attach(player)
        
        // Connect player to main mixer with standard format
        let format = engine.mainMixerNode.inputFormat(forBus: 0)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        
        self.audioEngine = engine
        self.playerNode = player
        self.currentFormat = format
        
        do {
            try engine.start()
            self.logger.info("Audio engine started for streaming")
        } catch {
            self.logger.error("Failed to start audio engine: \(error.localizedDescription)")
        }
    }
    
    /// Queue an audio chunk for playback
    func queueAudio(data: Data, sampleRate: Double = 16000.0) throws {
        guard !isStopped else { return }
        guard let playerNode = self.playerNode,
              let audioEngine = self.audioEngine,
              let engineFormat = self.currentFormat else {
            throw NSError(
                domain: "TalkStreamingAudioPlayer",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Player node not initialized"]
            )
        }
        
        // Write to temp file and read as AVAudioFile
        let tempURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString + ".wav")
        try data.write(to: tempURL)
        defer {
            try? FileManager.default.removeItem(at: tempURL)
        }
        
        let file = try AVAudioFile(forReading: tempURL)
        let frameCount = AVAudioFrameCount(file.length)
        
        guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, 
                                                  frameCapacity: frameCount) else {
            throw NSError(
                domain: "TalkStreamingAudioPlayer",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create source audio buffer"]
            )
        }
        
        try file.read(into: sourceBuffer)
        sourceBuffer.frameLength = frameCount
        
        // Convert to engine format if needed
        let bufferToSchedule: AVAudioPCMBuffer
        if file.processingFormat != engineFormat {
            self.logger.info(
                "Converting audio from \(file.processingFormat.sampleRate)Hz/\(file.processingFormat.channelCount)ch to \(engineFormat.sampleRate)Hz/\(engineFormat.channelCount)ch"
            )
            
            guard let converter = AVAudioConverter(from: file.processingFormat, to: engineFormat) else {
                throw NSError(
                    domain: "TalkStreamingAudioPlayer",
                    code: -3,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to create audio converter"]
                )
            }
            
            // Calculate converted frame count
            let convertedFrameCount = AVAudioFrameCount(
                Double(frameCount) * engineFormat.sampleRate / file.processingFormat.sampleRate
            )
            guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: engineFormat, 
                                                        frameCapacity: convertedFrameCount) else {
                throw NSError(
                    domain: "TalkStreamingAudioPlayer",
                    code: -4,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to create converted audio buffer"]
                )
            }
            
            // Perform conversion
            var error: NSError?
            nonisolated(unsafe) let sourceBuffer = sourceBuffer
            let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
                outStatus.pointee = .haveData
                return sourceBuffer
            }
            
            converter.convert(to: convertedBuffer, error: &error, withInputFrom: inputBlock)
            
            if let error = error {
                throw error
            }
            
            bufferToSchedule = convertedBuffer
        } else {
            bufferToSchedule = sourceBuffer
        }
        
        // Schedule buffer for playback
        buffersScheduled += 1
        let bufferIndex = buffersScheduled
        lastBufferCompleted = false
        
        playerNode.scheduleBuffer(bufferToSchedule, at: nil, options: []) { [weak self] in
            guard let self = self else { return }
            Task { @MainActor in
                self.buffersCompleted += 1
                self.logger.info("Buffer \(bufferIndex) completed (\(self.buffersCompleted)/\(self.buffersScheduled))")
                
                // Check if this is the last buffer
                if self.buffersCompleted == self.buffersScheduled {
                    self.lastBufferCompleted = true
                }
            }
        }
        
        // Start playing if not already
        if !isPlaying {
            playerNode.play()
            isPlaying = true
            self.logger.info("Started streaming audio playback")
        }
    }
    
    /// Stop streaming playback
    func stop() {
        isStopped = true
        playerNode?.stop()
        audioEngine?.stop()
        isPlaying = false
        lastBufferCompleted = true
        self.logger.info("Stopped streaming audio playback")
    }
    
    /// Reset for new stream
    func reset() {
        stop()
        isStopped = false
        buffersScheduled = 0
        buffersCompleted = 0
        lastBufferCompleted = true
        setupAudioEngine()
    }
    
    /// Wait for all queued audio to finish
    func waitForCompletion() async {
        // Wait until all scheduled buffers have completed
        while !lastBufferCompleted && !isStopped {
            try? await Task.sleep(nanoseconds: 100_000_000) // 0.1 seconds
        }
        
        self.logger.info("All audio buffers completed (\(self.buffersCompleted)/\(self.buffersScheduled))")
    }
}

