#if DEBUG
import AVFAudio
import Foundation
import OpenClawChatUI

/// UI-test fixture for a simulator whose Mac has no audio input, where every real recording fails to
/// start. It keeps the real microphone permission request and writes silence as the m4a a recording
/// would make. `--openclaw-voice-note-fixture` picks it, in screenshot mode only.
@MainActor
final class VoiceNoteFixtureCapture: VoiceNoteAudioCapture {
    private var recording: (url: URL, startedAt: Date)?

    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start(url: URL) throws {
        self.recording = (url, Date())
    }

    func stop() -> TimeInterval {
        guard let recording else { return 0 }
        self.recording = nil
        let duration = Date().timeIntervalSince(recording.startedAt)
        let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)
        let frames = AVAudioFrameCount(max(1, duration * 24000))
        if let format, let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) {
            silence.frameLength = frames
            silence.floatChannelData?[0].update(repeating: 0, count: Int(frames))
            // A failed write leaves no file, and attaching it then shows its own error.
            let file = try? AVAudioFile(forWriting: recording.url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 24000,
                AVNumberOfChannelsKey: 1,
            ])
            try? file?.write(from: silence)
        }
        return duration
    }

    func cancel() {
        self.recording = nil
    }

    func setFailureHandler(_ handler: @escaping @MainActor () -> Void) {}
}
#endif
