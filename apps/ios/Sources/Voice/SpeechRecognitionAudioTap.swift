import AVFAudio
import Speech

enum SpeechRecognitionAudioTap {
    /// Core Audio invokes this off MainActor. Append synchronously while its buffer is valid.
    nonisolated static func make(
        request: SFSpeechAudioBufferRecognitionRequest,
        onBuffer: (@Sendable (AVAudioPCMBuffer) -> Void)? = nil)
        -> AVAudioNodeTapBlock
    {
        { buffer, _ in
            request.append(buffer)
            onBuffer?(buffer)
        }
    }
}
