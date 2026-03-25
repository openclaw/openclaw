using Windows.Media.SpeechRecognition;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.TalkMode;

// Continuous and one-shot STT via Windows.Media.SpeechRecognition.SpeechRecognizer.
// WinRT recognition runs entirely on-device — no cloud round-trip regardless of RecognitionMode.
// Requires 'microphone' capability in Package.appxmanifest.
internal sealed class WinRTSpeechRecognizerAdapter : ISpeechRecognizer, IAsyncDisposable
{
    private readonly ILogger<WinRTSpeechRecognizerAdapter> _logger;
    private SpeechRecognizer? _recognizer;

    // Bump generation so stale callbacks from cancelled recognition tasks are dropped silently
    private int _recognitionGeneration;

    // WinRT recognition is always local
    public bool SupportsOnDeviceRecognition => true;

    public WinRTSpeechRecognizerAdapter(ILogger<WinRTSpeechRecognizerAdapter> logger)
    {
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> StartAsync(CancellationToken ct)
    {
        _recognizer = new SpeechRecognizer();
        var result = await _recognizer.CompileConstraintsAsync().AsTask(ct);
        if (result.Status != SpeechRecognitionResultStatus.Success)
        {
            _logger.LogError("Constraint compile failed: {S}", result.Status);
            return Error.Failure("STT_COMPILE_FAILED", result.Status.ToString());
        }
        return Result.Success;
    }

    public async Task StopAsync(CancellationToken ct)
    {
        Interlocked.Increment(ref _recognitionGeneration);
        if (_recognizer is not null)
            await _recognizer.ContinuousRecognitionSession.StopAsync().AsTask(ct);
    }

    public async Task<ErrorOr<Success>> RestartAsync(CancellationToken ct)
    {
        await StopAsync(ct);
        return await StartAsync(ct);
    }

    public async Task StartContinuousAsync(
        RecognitionMode mode,
        Func<string, float, Task> onPartialResult,
        Func<string, float, Task> onFinalResult,
        CancellationToken ct)
    {
        if (_recognizer is null)
        {
            var init = await StartAsync(ct);
            if (init.IsError) return;
        }

        // mode is accepted for interface parity but WinRT is always on-device — no flag to set.

        var myGeneration = _recognitionGeneration;

        // Hypotheses carry no confidence in WinRT — pass 0f to match iOS partial behavior.
        _recognizer!.HypothesisGenerated += async (_, args) =>
        {
            if (_recognitionGeneration != myGeneration) return;
            await onPartialResult(args.Hypothesis.Text, 0f);
        };

        _recognizer.ContinuousRecognitionSession.ResultGenerated += async (_, args) =>
        {
            if (_recognitionGeneration != myGeneration) return;
            if (args.Result.Status == SpeechRecognitionResultStatus.Success)
            {
                // RawConfidence is [0..1]
                var confidence = (float)args.Result.RawConfidence;
                await onFinalResult(args.Result.Text, confidence);
            }
        };

        await _recognizer.ContinuousRecognitionSession
            .StartAsync().AsTask(ct);

        await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
    }

    public async ValueTask DisposeAsync()
    {
        if (_recognizer is not null)
        {
            await _recognizer.ContinuousRecognitionSession.StopAsync()
                .AsTask(CancellationToken.None);
            _recognizer.Dispose();
            _recognizer = null;
        }
    }
}
