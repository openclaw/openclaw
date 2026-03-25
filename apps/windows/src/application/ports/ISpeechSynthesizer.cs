namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Text-to-speech synthesis and PCM playback.
/// Implemented by WinRTSpeechSynthAdapter (Windows.Media.SpeechSynthesis).
/// </summary>
public interface ISpeechSynthesizer
{
    // Returns display names of all installed TTS voices.
    IReadOnlyList<string> GetAvailableVoices();

    // Selects the active voice by display name. Empty string restores the system default.
    void SetVoice(string voiceDisplayName);

    Task<ErrorOr<Success>> SpeakAsync(string text, CancellationToken ct);
    Task StopAsync(CancellationToken ct);

    // Pauses ongoing playback without discarding the stream.
    Task PauseAsync(CancellationToken ct);

    // Resumes a paused playback.
    Task ResumeAsync(CancellationToken ct);
}
