import AVFoundation
import Foundation

@MainActor
public final class TalkSystemSpeechSynthesizer: NSObject {
    public enum SpeakError: Error {
        case canceled
    }

    public static let shared = TalkSystemSpeechSynthesizer()

    private let synth = AVSpeechSynthesizer()
    private var speakContinuation: CheckedContinuation<Void, Error>?
    private var currentUtterance: AVSpeechUtterance?
    private var didStartCallback: (() -> Void)?
    private var currentToken = UUID()
    private var watchdog: Task<Void, Never>?

    public var isSpeaking: Bool { self.synth.isSpeaking }

    override private init() {
        super.init()
        self.synth.delegate = self
    }

    public func stop() {
        self.currentToken = UUID()
        self.watchdog?.cancel()
        self.watchdog = nil
        self.didStartCallback = nil
        self.synth.stopSpeaking(at: .immediate)
        self.finishCurrent(with: SpeakError.canceled)
    }

    public func speak(
        text: String,
        language: String? = nil,
        onStart: (() -> Void)? = nil
    ) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        self.stop()
        let token = UUID()
        self.currentToken = token
        self.didStartCallback = onStart

        let utterance = AVSpeechUtterance(string: trimmed)
        if let language, let voice = AVSpeechSynthesisVoice(language: language) {
            utterance.voice = voice
        }
        self.currentUtterance = utterance

        let estimatedSeconds = max(3.0, min(180.0, Double(trimmed.count) * 0.08))
        self.watchdog?.cancel()
        self.watchdog = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(estimatedSeconds * 1_000_000_000))
            if Task.isCancelled { return }
            guard self.currentToken == token else { return }
            if self.synth.isSpeaking {
                self.synth.stopSpeaking(at: .immediate)
            }
            self.finishCurrent(
                with: NSError(domain: "TalkSystemSpeechSynthesizer", code: 408, userInfo: [
                    NSLocalizedDescriptionKey: "system TTS timed out after \(estimatedSeconds)s",
                ]))
        }

        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { cont in
                self.speakContinuation = cont
                self.synth.speak(utterance)
            }
        }, onCancel: {
            Task { @MainActor in
                self.stop()
            }
        })

        if self.currentToken != token {
            throw SpeakError.canceled
        }
    }

    private func matchesCurrentUtterance(_ utteranceID: ObjectIdentifier) -> Bool {
        guard let currentUtterance = self.currentUtterance else { return false }
        return ObjectIdentifier(currentUtterance) == utteranceID
    }

    private func handleFinish(utteranceID: ObjectIdentifier, error: Error?) {
        guard self.matchesCurrentUtterance(utteranceID) else { return }
        self.watchdog?.cancel()
        self.watchdog = nil
        self.finishCurrent(with: error)
    }

    private func finishCurrent(with error: Error?) {
        self.currentUtterance = nil
        self.didStartCallback = nil
        let cont = self.speakContinuation
        self.speakContinuation = nil
        if let error {
            cont?.resume(throwing: error)
        } else {
            cont?.resume(returning: ())
        }
    }
}

extension TalkSystemSpeechSynthesizer: AVSpeechSynthesizerDelegate {
    public nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didStart utterance: AVSpeechUtterance)
    {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor in
            guard self.matchesCurrentUtterance(utteranceID) else { return }
            let callback = self.didStartCallback
            self.didStartCallback = nil
            callback?()
        }
    }

    public nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance)
    {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor in
            self.handleFinish(utteranceID: utteranceID, error: nil)
        }
    }

    public nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance)
    {
        let utteranceID = ObjectIdentifier(utterance)
        Task { @MainActor in
            self.handleFinish(utteranceID: utteranceID, error: SpeakError.canceled)
        }
    }
}
