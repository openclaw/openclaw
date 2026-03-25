using Windows.Media.Playback;
using Windows.Media.SpeechSynthesis;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.TalkMode;

// TTS synthesis and playback via Windows.Media.SpeechSynthesis.SpeechSynthesizer.
internal sealed class WinRTSpeechSynthAdapter : ISpeechSynthesizer, IDisposable
{
    private readonly ILogger<WinRTSpeechSynthAdapter> _logger;
    private readonly SpeechSynthesizer _synth = new();
    private readonly MediaPlayer _player = new();
    private TaskCompletionSource<bool>? _playbackTcs;

    public WinRTSpeechSynthAdapter(ILogger<WinRTSpeechSynthAdapter> logger)
    {
        _logger = logger;

        _player.MediaEnded += (_, _) =>
            _playbackTcs?.TrySetResult(true);

        _player.MediaFailed += (_, args) =>
            _playbackTcs?.TrySetException(new InvalidOperationException(args.ErrorMessage));
    }

    // ── Voice management ──────────────────────────────────────────────────────

    public IReadOnlyList<string> GetAvailableVoices() =>
        SpeechSynthesizer.AllVoices.Select(v => v.DisplayName).ToList();

    public void SetVoice(string voiceDisplayName)
    {
        if (string.IsNullOrEmpty(voiceDisplayName))
        {
            // Restore system default
            _synth.Voice = SpeechSynthesizer.DefaultVoice;
            return;
        }

        var match = SpeechSynthesizer.AllVoices
            .FirstOrDefault(v => string.Equals(v.DisplayName, voiceDisplayName, StringComparison.OrdinalIgnoreCase));

        if (match is not null)
            _synth.Voice = match;
        else
            _logger.LogWarning("TTS voice not found: {Name}", voiceDisplayName);
    }

    // ── Playback ──────────────────────────────────────────────────────────────

    public async Task<ErrorOr<Success>> SpeakAsync(string text, CancellationToken ct)
    {
        try
        {
            // Interrupt previous playback on new speak request
            _player.Pause();
            _playbackTcs?.TrySetCanceled();

            var stream = await _synth.SynthesizeTextToStreamAsync(text).AsTask(ct);

            _playbackTcs = new TaskCompletionSource<bool>();
            _player.Source = Windows.Media.Core.MediaSource.CreateFromStream(stream, stream.ContentType);
            _player.Play();

            await _playbackTcs.Task.WaitAsync(ct);
            return Result.Success;
        }
        catch (OperationCanceledException)
        {
            _player.Pause();
            return Result.Success; // cancellation is not an error
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TTS playback failed for text length={L}", text.Length);
            return Error.Failure("TTS_FAILED", ex.Message);
        }
    }

    public Task StopAsync(CancellationToken ct)
    {
        _player.Pause();
        _playbackTcs?.TrySetCanceled();
        _playbackTcs = null;
        return Task.CompletedTask;
    }

    public Task PauseAsync(CancellationToken ct)
    {
        _player.Pause();
        return Task.CompletedTask;
    }

    public Task ResumeAsync(CancellationToken ct)
    {
        _player.Play();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _player.Dispose();
        _synth.Dispose();
    }
}
