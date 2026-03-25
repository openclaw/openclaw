using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Infrastructure.VoiceWake;

/// <summary>
/// Live wake-word recognition test engine used in Settings.
/// Drives ISpeechRecognizer and matches transcripts via text-only gate.
/// </summary>
// Ear-trigger/stop lifecycle omitted — no Windows equivalent.
// Privacy strings and permission check omitted — handled by app manifest.
internal sealed class VoiceWakeTester : IVoiceWakeTesterService
{
    // Tunables
    internal static readonly TimeSpan SilenceWindow   = TimeSpan.FromSeconds(1.0);
    internal static readonly TimeSpan FinalizeTimeout = TimeSpan.FromSeconds(1.5);
    internal static readonly TimeSpan HoldHardStop    = TimeSpan.FromSeconds(6.0);
    internal const int SilencePollMs = 200;

    // Failure messages used in onUpdate() callbacks
    internal const string MsgNoSpeech   = "No speech detected";
    internal const string MsgNoTrigger  = "No trigger heard: ";  // prefix; transcript appended

    private readonly ISpeechRecognizer               _recognizer;
    private readonly ILogger<VoiceWakeTester>        _logger;

    private CancellationTokenSource? _cts;
    private CancellationTokenSource? _silenceCts;
    private volatile bool            _isStopping;
    private volatile bool            _isFinalizing;
    private volatile bool            _holdingAfterDetect;
    private string?                  _detectedText;
    private DateTime?                _lastHeard;
    private string?                  _lastTranscript;
    private DateTime?                _lastTranscriptAt;
    private List<string>             _currentTriggers = [];

    internal VoiceWakeTester(ISpeechRecognizer recognizer, ILogger<VoiceWakeTester> logger)
    {
        _recognizer = recognizer;
        _logger     = logger;
    }

    internal async Task StartAsync(
        IEnumerable<string>              triggers,
        string?                          micID,
        string?                          localeID,
        Action<VoiceWakeTestState>       onUpdate,
        CancellationToken                ct = default)
    {
        if (_cts != null) return;

        _isStopping         = false;
        _isFinalizing       = false;
        _holdingAfterDetect = false;
        _detectedText       = null;
        _lastHeard          = null;
        _lastTranscript     = null;
        _lastTranscriptAt   = null;
        _silenceCts?.Cancel();
        _silenceCts         = null;
        _currentTriggers    = VoiceWakeHelpers.SanitizeTriggers(triggers).ToList();

        // ISpeechRecognizer does not expose mic or locale selection
        _ = micID;
        _ = localeID;

        _cts = CancellationTokenSource.CreateLinkedTokenSource(ct);

        onUpdate(VoiceWakeTestState.Listening.Instance);
        _lastHeard = DateTime.UtcNow;

        // StartContinuousAsync blocks until _cts is cancelled; run on thread-pool.
        _ = Task.Run(async () =>
        {
            try
            {
                await _recognizer.StartContinuousAsync(
                    RecognitionMode.Auto,
                    onPartialResult: async (text, _) =>
                    {
                        if (!_isStopping)
                            await HandleResultAsync(text, isFinal: false, onUpdate);
                    },
                    onFinalResult: async (text, _) =>
                    {
                        if (!_isStopping)
                            await HandleResultAsync(text, isFinal: true, onUpdate);
                    },
                    ct: _cts.Token);
            }
            catch (OperationCanceledException) { /* normal stop via _cts.Cancel() */ }
            catch (Exception ex)
            {
                _logger.LogError(ex, "VoiceWakeTester recognition error");
                if (!_isStopping)
                    onUpdate(new VoiceWakeTestState.Failed(ex.Message));
            }
        });

        await Task.CompletedTask;
    }

    internal void Stop() => StopCore(force: true);

    internal void Finalize(TimeSpan timeout = default)
    {
        var t = timeout == default ? FinalizeTimeout : timeout;
        if (_cts is null) { StopCore(force: true); return; }

        _isFinalizing = true;
        // ISpeechRecognizer has no separate endAudio; wait timeout then stop.
        _ = Task.Run(async () =>
        {
            await Task.Delay(t);
            if (!_isStopping) StopCore(force: true);
        });
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private void StopCore(bool force)
    {
        if (force) _isStopping = true;
        _isFinalizing = false;

        var cts = Interlocked.Exchange(ref _cts, null);
        cts?.Cancel();
        cts?.Dispose();

        _ = _recognizer.StopAsync(CancellationToken.None);

        _silenceCts?.Cancel();
        _silenceCts = null;

        _holdingAfterDetect = false;
        _detectedText       = null;
        _lastHeard          = null;
        _lastTranscript     = null;
        _lastTranscriptAt   = null;
        _currentTriggers    = [];
    }

    private async Task HandleResultAsync(string text, bool isFinal, Action<VoiceWakeTestState> onUpdate)
    {
        if (!string.IsNullOrEmpty(text))
        {
            _lastHeard        = DateTime.UtcNow;
            _lastTranscript   = text;
            _lastTranscriptAt = DateTime.UtcNow;
        }

        if (_holdingAfterDetect) return;

        // On Windows all results use the text-only path (no segment timing available).
        var command = VoiceWakeTextUtils.TextOnlyCommand(
            text, _currentTriggers, minCommandLength: 1, TrimWake);

        if (command != null)
        {
            _holdingAfterDetect = true;
            _detectedText       = command;
            _logger.LogInformation("VoiceWake detected (test) len={Len}", command.Length);
            StopCore(force: true);
            onUpdate(new VoiceWakeTestState.Detected(command));
            return;
        }

        if (!isFinal && !string.IsNullOrEmpty(text))
            ScheduleSilenceCheck(_currentTriggers, onUpdate);

        if (_isFinalizing)
            onUpdate(VoiceWakeTestState.Finalizing.Instance);

        if (isFinal)
        {
            StopCore(force: true);
            var state = string.IsNullOrEmpty(text)
                ? new VoiceWakeTestState.Failed(MsgNoSpeech)
                : new VoiceWakeTestState.Failed($"{MsgNoTrigger}\"{text}\"");
            onUpdate(state);
        }
        else
        {
            var state = string.IsNullOrEmpty(text)
                ? (VoiceWakeTestState)VoiceWakeTestState.Listening.Instance
                : new VoiceWakeTestState.Hearing(text);
            onUpdate(state);
        }

        await Task.CompletedTask;
    }

    private void ScheduleSilenceCheck(List<string> triggers, Action<VoiceWakeTestState> onUpdate)
    {
        _silenceCts?.Cancel();
        _silenceCts = new CancellationTokenSource();
        var silenceCt    = _silenceCts.Token;
        var lastSeenAt   = _lastTranscriptAt;
        var lastText     = _lastTranscript;

        _ = Task.Run(async () =>
        {
            try { await Task.Delay(SilenceWindow, silenceCt); }
            catch (OperationCanceledException) { return; }

            if (silenceCt.IsCancellationRequested) return;
            if (_isStopping || _holdingAfterDetect) return;

            if (lastSeenAt != _lastTranscriptAt || lastText != _lastTranscript) return;
            if (lastText is null) return;

            var command = VoiceWakeTextUtils.TextOnlyCommand(
                lastText, triggers, minCommandLength: 1, TrimWake);
            if (command is null) return;

            _holdingAfterDetect = true;
            _detectedText       = command;
            _logger.LogInformation("VoiceWake detected (test, silence) len={Len}", command.Length);
            StopCore(force: true);
            onUpdate(new VoiceWakeTestState.Detected(command));
        });
    }

    // Strips the first matching trigger from the transcript start.
    internal static string TrimWake(string transcript, IEnumerable<string> triggers)
    {
        var words = transcript.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);

        foreach (var trigger in triggers)
        {
            var triggerWords = trigger
                .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
                .Select(VoiceWakeTextUtils.NormalizeToken)
                .Where(t => t.Length > 0)
                .ToArray();

            if (triggerWords.Length == 0 || words.Length <= triggerWords.Length) continue;

            var normalizedWords = words.Select(VoiceWakeTextUtils.NormalizeToken).ToArray();
            if (triggerWords.Zip(normalizedWords).All(p => p.First == p.Second))
                return string.Join(" ", words.Skip(triggerWords.Length));
        }

        return transcript;
    }

    // ── IVoiceWakeTesterService — explicit to avoid CS0465 on Finalize ────────

    Task IVoiceWakeTesterService.StartAsync(
        IEnumerable<string> triggers, string? micID, string? localeID,
        Action<VoiceWakeTestState> onUpdate, CancellationToken ct)
        => StartAsync(triggers, micID, localeID, onUpdate, ct);

    void IVoiceWakeTesterService.Stop() => Stop();

    void IVoiceWakeTesterService.Finalize(TimeSpan timeout) => Finalize(timeout);
}
