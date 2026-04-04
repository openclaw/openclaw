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
    private static let defaultPitchMultiplier: Float = 1.02

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
        voiceIdentifier: String? = nil,
        rate: Float? = nil,
        pitchMultiplier: Float? = nil,
        onStart: (() -> Void)? = nil
    ) async throws {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        self.stop()
        let token = UUID()
        self.currentToken = token
        self.didStartCallback = onStart

        let utterance = AVSpeechUtterance(string: trimmed)
        let resolvedVoiceIdentifier =
            voiceIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            ? voiceIdentifier
            : Self.preferredVoiceIdentifier(language: language)
        if
            let resolvedVoiceIdentifier,
            let voice = AVSpeechSynthesisVoice(identifier: resolvedVoiceIdentifier)
        {
            utterance.voice = voice
        } else if let language, let voice = AVSpeechSynthesisVoice(language: language) {
            utterance.voice = voice
        }
        utterance.rate = min(AVSpeechUtteranceMaximumSpeechRate,
                             max(AVSpeechUtteranceMinimumSpeechRate, rate ?? Self.preferredRate(language: language)))
        utterance.pitchMultiplier = min(2.0, max(0.5, pitchMultiplier ?? Self.defaultPitchMultiplier))
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

    private static func preferredRate(language: String?) -> Float {
        guard let normalized = self.normalizedLanguage(language) else { return 0.45 }
        if normalized.hasPrefix("zh") { return 0.43 }
        if normalized.hasPrefix("ja") || normalized.hasPrefix("ko") { return 0.44 }
        if normalized.hasPrefix("en") { return 0.46 }
        return 0.45
    }

    private static func preferredVoiceIdentifier(language: String?) -> String? {
        let available = Set(AVSpeechSynthesisVoice.speechVoices().map(\.identifier))
        let candidates = self.voiceCandidates(language: language)
        if let matched = candidates.first(where: { available.contains($0) }) {
            return matched
        }
        if
            let normalized = self.normalizedLanguage(language),
            let voice = AVSpeechSynthesisVoice(language: normalized)
        {
            return voice.identifier
        }
        return nil
    }

    private static func normalizedLanguage(_ language: String?) -> String? {
        let trimmed = language?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed.replacingOccurrences(of: "_", with: "-") }
        return Locale.preferredLanguages.first?.replacingOccurrences(of: "_", with: "-")
    }

    private static func voiceCandidates(language: String?) -> [String] {
        let normalized = self.normalizedLanguage(language)?.lowercased() ?? "en-us"
        switch normalized {
        case let value where value.hasPrefix("zh-cn"):
            return [
                "com.apple.voice.compact.zh-CN.Tingting",
                "com.apple.voice.super-compact.zh-CN.Tingting",
                "com.apple.eloquence.zh-CN.Flo",
                "com.apple.eloquence.zh-CN.Shelley",
            ]
        case let value where value.hasPrefix("zh-tw"):
            return [
                "com.apple.voice.super-compact.zh-TW.Meijia",
                "com.apple.eloquence.zh-TW.Flo",
                "com.apple.eloquence.zh-TW.Shelley",
            ]
        case let value where value.hasPrefix("en-gb"):
            return [
                "com.apple.voice.super-compact.en-GB.Daniel",
                "com.apple.eloquence.en-GB.Flo",
                "com.apple.eloquence.en-GB.Shelley",
            ]
        case let value where value.hasPrefix("en"):
            return [
                "com.apple.voice.super-compact.en-US.Samantha",
                "com.apple.eloquence.en-US.Flo",
                "com.apple.eloquence.en-US.Shelley",
            ]
        case let value where value.hasPrefix("ja"):
            return [
                "com.apple.voice.super-compact.ja-JP.Kyoko",
                "com.apple.eloquence.ja-JP.Flo",
            ]
        case let value where value.hasPrefix("ko"):
            return [
                "com.apple.voice.super-compact.ko-KR.Yuna",
                "com.apple.eloquence.ko-KR.Flo",
            ]
        default:
            return []
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
