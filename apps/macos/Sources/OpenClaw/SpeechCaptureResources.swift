import AVFoundation
import Foundation
import OpenClawKit
import Speech
import SwabbleKit

/// Confined to its caller's actor or serial queue; callbacks stay off that executor.
final class SpeechCaptureResources {
    enum Mode: String, Sendable {
        case pushToTalk = "VoicePushToTalk"
        case dictation = "QuickChatDictation"
        case voiceWake = "VoiceWakeRuntime"
    }

    struct Update: Sendable {
        let transcript: String?
        let segments: [WakeWordSegment]
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

    var isRunning: Bool {
        self.task != nil
    }

    func validatePassiveVoiceWake(localeID: String) throws {
        guard try self.availableRecognizer(localeID: localeID).supportsOnDeviceRecognition else {
            throw SpeechRecognitionRequestPolicy.PolicyError.onDeviceRecognitionUnavailable
        }
    }

    private func availableRecognizer(localeID: String) throws -> SFSpeechRecognizer {
        let recognizer = self.recognizerCache.recognizer(localeID: localeID)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: self.mode.rawValue, code: 1, userInfo: [
                NSLocalizedDescriptionKey: self
                    .mode == .voiceWake ? "Speech recognition unavailable" : "Recognizer unavailable",
            ])
        }
        return recognizer
    }

    func start(
        localeID: String,
        onAudioLevel: (@Sendable (Double) -> Void)? = nil,
        onUpdate: @escaping @Sendable (Update) -> Void) throws
    {
        let recognizer = try self.availableRecognizer(localeID: localeID)
        let request = SFSpeechAudioBufferRecognitionRequest()
        self.request = request
        if self.mode == .voiceWake {
            try SpeechRecognitionRequestPolicy.configurePassiveVoiceWake(
                request, supportsOnDeviceRecognition: recognizer.supportsOnDeviceRecognition)
        } else {
            SpeechRecognitionRequestPolicy.configureInteractiveTranscription(request)
        }

        guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.engine = nil
            throw NSError(domain: self.mode.rawValue, code: self.mode == .dictation ? 2 : 1, userInfo: [
                NSLocalizedDescriptionKey: "No usable audio input device available",
            ])
        }
        let engine = self.engine ?? AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        if self.mode == .voiceWake, !(format.channelCount > 0 && format.sampleRate > 0) {
            throw NSError(domain: self.mode.rawValue, code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No audio input available",
            ])
        }
        input
            .installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
                request?.append(SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer))
                if let onAudioLevel { onAudioLevel(TalkAudioLevel.rms(buffer: buffer)) }
            }
        self.tapInstalled = true
        engine.prepare()
        try engine.start()

        let mode = self.mode
        self.task = recognizer.recognitionTask(with: request) { result, error in
            let transcription = result?.bestTranscription
            onUpdate(Update(
                transcript: transcription?.formattedString,
                segments: mode == .voiceWake ? transcription.map {
                    WakeWordSpeechSegments.from(transcription: $0, transcript: $0.formattedString)
                } ?? [] : [],
                isFinal: result?.isFinal ?? false,
                error: error))
        }
    }

    func finishAudio() {
        if self.mode == .voiceWake {
            // Passive diagnostics end Speech input before stopping their engine for the final-result drain.
            self.request?.endAudio()
            self.removeTap()
            self.engine?.stop()
            return
        }
        self.removeTap()
        self.request?.endAudio()
    }

    func stop() {
        if self.mode == .voiceWake {
            // Preserve the wake listener's cancel-first teardown; interactive captures keep their drain below.
            self.task?.cancel()
            self.task = nil
            self.request?.endAudio()
            self.request = nil
            self.removeTap()
            self.engine?.stop()
            self.engine = nil
            return
        }
        self.finishAudio()
        self.task?.cancel()
        self.task = nil
        self.request = nil
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
