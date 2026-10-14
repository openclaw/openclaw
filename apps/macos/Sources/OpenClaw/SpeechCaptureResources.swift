import AVFoundation
import Foundation
import Speech

/// Confined to its caller's actor or serial queue; callbacks stay off that executor.
final class SpeechCaptureResources {
    enum Mode: String {
        case pushToTalk = "VoicePushToTalk"
        case dictation = "QuickChatDictation"
    }

    struct Update: Sendable {
        let transcript: String?
        let isFinal: Bool
        let error: Error?
    }

    private let mode: Mode
    private var recognizerCache = SpeechRecognizerCache()
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var tapInstalled = false

    init(mode: Mode) {
        self.mode = mode
    }

    func start(localeID: String, onUpdate: @escaping @Sendable (Update) -> Void) throws {
        let recognizer = self.recognizerCache.recognizer(localeID: localeID)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: self.mode.rawValue, code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Recognizer unavailable",
            ])
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        self.request = request
        SpeechRecognitionRequestPolicy.configureInteractiveTranscription(request)

        // PTT creates its engine before checking the default input; dictation checks first.
        if self.mode == .pushToTalk {
            self.engine = self.engine ?? AVAudioEngine()
        }
        guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.engine = nil
            throw NSError(domain: self.mode.rawValue, code: self.mode == .pushToTalk ? 1 : 2, userInfo: [
                NSLocalizedDescriptionKey: "No usable audio input device available",
            ])
        }
        let engine = self.engine ?? AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        input
            .installTap(onBus: 0, bufferSize: 2048, format: input.outputFormat(forBus: 0)) { [weak request] buffer, _ in
                request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
            }
        self.tapInstalled = true
        engine.prepare()
        try engine.start()

        self.task = recognizer.recognitionTask(with: request) { result, error in
            onUpdate(Update(
                transcript: result?.bestTranscription.formattedString,
                isFinal: result?.isFinal ?? false,
                error: error))
        }
    }

    func finishAudio() {
        self.removeTap()
        self.request?.endAudio()
    }

    func stop() {
        if self.mode == .dictation {
            self.finishAudio()
        }
        self.task?.cancel()
        if self.mode == .pushToTalk {
            self.request = nil
            self.task = nil
            self.removeTap()
        } else {
            self.task = nil
            self.request = nil
        }
        if self.engine?.isRunning == true {
            self.engine?.stop()
            self.engine?.reset()
        }
        self.engine = nil
    }

    private func removeTap() {
        if self.tapInstalled {
            self.engine?.inputNode.removeTap(onBus: 0)
            self.tapInstalled = false
        }
    }
}
