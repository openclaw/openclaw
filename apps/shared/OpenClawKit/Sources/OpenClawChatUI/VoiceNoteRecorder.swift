import AVFAudio
import Foundation
import Observation

private let voiceNoteMaximumDurationSeconds: TimeInterval = 180

/// Audio capture operations driven by the voice-note recorder state machine.
@MainActor
public protocol VoiceNoteAudioCapture: AnyObject {
    /// Requests microphone access when recording is first used.
    func requestPermission() async -> Bool

    /// Starts writing an audio recording to the supplied URL.
    func start(url: URL) throws

    /// Stops capture and returns the recorded duration in seconds.
    func stop() -> TimeInterval

    /// Stops and discards the active capture.
    func cancel()
}

/// A completed voice-note recording ready to stage as a chat attachment.
public struct OpenClawVoiceNoteRecording: Equatable, Sendable {
    public let fileURL: URL
    public let durationSeconds: TimeInterval

    public init(fileURL: URL, durationSeconds: TimeInterval) {
        self.fileURL = fileURL
        self.durationSeconds = durationSeconds
    }
}

/// Main-actor voice-note recorder with explicit permission and capture states.
@MainActor
@Observable
public final class OpenClawVoiceNoteRecorder {
    public enum State: Equatable {
        case idle
        case requestingPermission
        case recording(startedAt: Date, fileURL: URL)
        case finished(recording: OpenClawVoiceNoteRecording)
        case failed(message: String)
    }

    public static let maximumDurationSeconds = voiceNoteMaximumDurationSeconds

    public private(set) var state: State = .idle
    public private(set) var elapsedSeconds: TimeInterval = 0

    @ObservationIgnored public var onRecordingActiveChanged: (@MainActor (Bool) -> Void)?

    @ObservationIgnored private let capture: any VoiceNoteAudioCapture
    @ObservationIgnored private let durationLimit: TimeInterval
    @ObservationIgnored private let timerIntervalNanoseconds: UInt64
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var timerTask: Task<Void, Never>?

    /// Creates a recorder backed by the system audio recorder.
    public convenience init() {
        self.init(capture: OpenClawVoiceNoteAudioCapture())
    }

    /// Creates a recorder with an injectable audio capture seam.
    public init(
        capture: any VoiceNoteAudioCapture,
        durationLimit: TimeInterval = OpenClawVoiceNoteRecorder.maximumDurationSeconds,
        timerIntervalNanoseconds: UInt64 = 100_000_000,
        now: @escaping () -> Date = Date.init)
    {
        self.capture = capture
        self.durationLimit = durationLimit
        self.timerIntervalNanoseconds = timerIntervalNanoseconds
        self.now = now
    }

    deinit {
        self.timerTask?.cancel()
    }

    public var isRecording: Bool {
        if case .recording = self.state { return true }
        return false
    }

    public var isRequestingPermission: Bool {
        self.state == .requestingPermission
    }

    public var errorMessage: String? {
        guard case let .failed(message) = self.state else { return nil }
        return message
    }

    public var completedRecording: OpenClawVoiceNoteRecording? {
        guard case let .finished(recording) = self.state else { return nil }
        return recording
    }

    /// Requests permission if needed and starts a new recording.
    @discardableResult
    public func start() async -> Bool {
        guard self.state == .idle || self.errorMessage != nil else { return false }

        self.elapsedSeconds = 0
        self.state = .requestingPermission
        guard await self.capture.requestPermission() else {
            self.fail(message: String(localized: "Microphone access is required. Enable it in Settings."))
            return false
        }
        guard self.state == .requestingPermission else { return false }

        let fileURL = self.makeTemporaryFileURL()
        self.onRecordingActiveChanged?(true)
        do {
            try self.capture.start(url: fileURL)
        } catch {
            try? FileManager.default.removeItem(at: fileURL)
            self.capture.cancel()
            self.onRecordingActiveChanged?(false)
            self.fail(message: String(localized: "Could not start recording: \(error.localizedDescription)"))
            return false
        }

        self.state = .recording(startedAt: self.now(), fileURL: fileURL)
        self.startTimer()
        return true
    }

    /// Finishes the active recording and publishes its attachment handoff.
    @discardableResult
    public func finish() -> OpenClawVoiceNoteRecording? {
        guard case let .recording(_, fileURL) = self.state else { return nil }

        self.timerTask?.cancel()
        self.timerTask = nil
        let duration = max(0, self.capture.stop())
        let recording = OpenClawVoiceNoteRecording(fileURL: fileURL, durationSeconds: duration)
        self.elapsedSeconds = duration
        self.state = .finished(recording: recording)
        self.onRecordingActiveChanged?(false)
        return recording
    }

    /// Cancels permission or capture and removes any temporary audio file.
    public func cancel() {
        let fileURL: URL? = switch self.state {
        case let .recording(_, fileURL):
            fileURL
        case let .finished(recording):
            recording.fileURL
        default:
            nil
        }

        self.timerTask?.cancel()
        self.timerTask = nil
        self.capture.cancel()
        if let fileURL {
            try? FileManager.default.removeItem(at: fileURL)
        }
        let wasRecording = self.isRecording
        self.elapsedSeconds = 0
        self.state = .idle
        if wasRecording {
            self.onRecordingActiveChanged?(false)
        }
    }

    /// Clears a completed handoff after the composer has staged it.
    public func clearCompletedRecording() {
        guard case .finished = self.state else { return }
        self.state = .idle
        self.elapsedSeconds = 0
    }

    private func startTimer() {
        self.timerTask?.cancel()
        self.timerTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: self.timerIntervalNanoseconds)
                guard !Task.isCancelled else { return }
                guard case let .recording(startedAt, _) = self.state else { return }
                self.elapsedSeconds = max(0, self.now().timeIntervalSince(startedAt))
                if self.elapsedSeconds >= self.durationLimit {
                    self.finish()
                    return
                }
            }
        }
    }

    private func fail(message: String) {
        self.timerTask?.cancel()
        self.timerTask = nil
        let wasRecording = self.isRecording
        self.elapsedSeconds = 0
        self.state = .failed(message: message)
        if wasRecording {
            self.onRecordingActiveChanged?(false)
        }
    }

    private func makeTemporaryFileURL() -> URL {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        let timestamp = formatter.string(from: self.now())
        return FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-note-\(timestamp).m4a")
    }
}

/// AVAudioRecorder-backed AAC voice-note capture.
@MainActor
public final class OpenClawVoiceNoteAudioCapture: VoiceNoteAudioCapture {
    private var recorder: AVAudioRecorder?
    private var ownsAudioSession = false

    public init() {}

    public func requestPermission() async -> Bool {
        #if os(iOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
        #else
        return false
        #endif
    }

    public func start(url: URL) throws {
        do {
            #if os(iOS)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
            try session.setActive(true)
            self.ownsAudioSession = true
            #endif

            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 24000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32000,
                AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
            ]
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            guard recorder.record() else {
                throw NSError(
                    domain: "OpenClawVoiceNoteAudioCapture",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Audio recorder refused to start"])
            }
            self.recorder = recorder
        } catch {
            self.deactivateAudioSession()
            throw error
        }
    }

    public func stop() -> TimeInterval {
        guard let recorder = self.recorder else { return 0 }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        self.deactivateAudioSession()
        return duration
    }

    public func cancel() {
        self.recorder?.stop()
        self.recorder = nil
        self.deactivateAudioSession()
    }

    private func deactivateAudioSession() {
        #if os(iOS)
        guard self.ownsAudioSession else { return }
        self.ownsAudioSession = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

func openClawVoiceNoteDurationLabel(_ durationSeconds: TimeInterval) -> String {
    guard durationSeconds.isFinite else { return "0:00" }
    let boundedDuration = min(
        max(0, durationSeconds),
        voiceNoteMaximumDurationSeconds)
    let totalSeconds = Int(boundedDuration)
    return String(format: "%d:%02d", totalSeconds / 60, totalSeconds % 60)
}
