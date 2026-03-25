namespace OpenClawWindows.Application.Ports;

// Quality hint for the recognition session.
// On Windows, WinRT recognition is always local, so both values behave identically.
public enum RecognitionMode { Auto, OnDevice }

/// <summary>
/// Continuous speech-to-text recognition.
/// Implemented by WinRTSpeechRecognizerAdapter (Windows.Media.SpeechRecognition).
/// </summary>
public interface ISpeechRecognizer
{
    // True when on-device recognition is available without a network round-trip.
    bool SupportsOnDeviceRecognition { get; }

    Task<ErrorOr<Success>> StartAsync(CancellationToken ct);
    Task StopAsync(CancellationToken ct);
    Task<ErrorOr<Success>> RestartAsync(CancellationToken ct);

    // Confidence is in [0..1] — sourced from SpeechRecognitionResult.RawConfidence.
    // Partial results carry 0f because WinRT does not expose confidence for hypotheses.
    Task StartContinuousAsync(
        RecognitionMode mode,
        Func<string, float, Task> onPartialResult,
        Func<string, float, Task> onFinalResult,
        CancellationToken ct);
}
