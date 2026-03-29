using System.Runtime.InteropServices;
using Microsoft.Skype.Bots.Media;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// Handles TTS audio injection into a Teams call via IAudioSocket.Send().
///
/// Receives PCM data (16kHz mono 16-bit signed LE) from the gRPC PlayAudio
/// client-streaming call, buffers it into 20ms frames (640 bytes each), and
/// sends them to the media SDK. Supports immediate cancellation for barge-in
/// scenarios where a human starts speaking mid-playback.
/// </summary>
public sealed class AudioPlayback : IDisposable
{
    /// <summary>
    /// Frame size: 20ms of 16kHz mono 16-bit = 640 bytes.
    /// The Teams media SDK requires audio to be sent in exact 20ms frames.
    /// </summary>
    public const int FrameSizeBytes = 640;

    /// <summary>
    /// Frame duration in milliseconds.
    /// </summary>
    public const int FrameDurationMs = 20;

    /// <summary>
    /// Playback interval between frames. Slightly under 20ms to account for
    /// processing overhead and keep the send buffer ahead of playout.
    /// </summary>
    private const int PlaybackIntervalMs = 18;

    private readonly IAudioSocket _audioSocket;
    private readonly ILogger<AudioPlayback> _logger;
    private readonly object _lock = new();
    private CancellationTokenSource? _activeCts;
    private Task? _activePlaybackTask;
    private bool _disposed;

    public AudioPlayback(IAudioSocket audioSocket, ILogger<AudioPlayback> logger)
    {
        _audioSocket = audioSocket;
        _logger = logger;
    }

    /// <summary>
    /// Queues PCM data for playback. The data is buffered and sent as 20ms
    /// frames. If playback is already active, the new data is appended.
    /// Call <see cref="StopPlayback"/> to cancel immediately.
    /// </summary>
    /// <param name="pcmData">Raw PCM bytes: 16kHz, mono, 16-bit signed LE.</param>
    /// <param name="callId">Call identifier for logging.</param>
    /// <returns>A task that completes when all frames have been sent or playback is cancelled.</returns>
    public async Task PlayAsync(byte[] pcmData, string callId)
    {
        if (_disposed) return;

        CancellationTokenSource cts;
        lock (_lock)
        {
            // Cancel any prior playback (only one active playback per call).
            _activeCts?.Cancel();
            _activeCts?.Dispose();
            _activeCts = new CancellationTokenSource();
            cts = _activeCts;
        }

        _logger.LogInformation(
            "Starting playback for call {CallId}: {Bytes} bytes ({Duration}ms)",
            callId, pcmData.Length, pcmData.Length / (FrameSizeBytes / FrameDurationMs));

        _activePlaybackTask = SendFramesAsync(pcmData, cts.Token);
        await _activePlaybackTask;
    }

    /// <summary>
    /// Immediately stops any active playback (barge-in support).
    /// </summary>
    public void StopPlayback()
    {
        lock (_lock)
        {
            if (_activeCts != null)
            {
                _logger.LogInformation("Stopping playback (barge-in)");
                _activeCts.Cancel();
                _activeCts.Dispose();
                _activeCts = null;
            }
        }
    }

    /// <summary>
    /// Sends PCM data as a sequence of 20ms frames to the audio socket.
    /// </summary>
    private async Task SendFramesAsync(byte[] pcmData, CancellationToken ct)
    {
        int offset = 0;
        int totalFrames = pcmData.Length / FrameSizeBytes;
        int frameIndex = 0;

        try
        {
            while (offset + FrameSizeBytes <= pcmData.Length && !ct.IsCancellationRequested)
            {
                var frameData = new byte[FrameSizeBytes];
                Buffer.BlockCopy(pcmData, offset, frameData, 0, FrameSizeBytes);

                var sendBuffer = CreateAudioSendBuffer(frameData, frameIndex);
                _audioSocket.Send(sendBuffer);

                offset += FrameSizeBytes;
                frameIndex++;

                // Pace the send to match real-time playback rate.
                await Task.Delay(PlaybackIntervalMs, ct);
            }

            // Handle a trailing partial frame: pad with silence.
            int remaining = pcmData.Length - offset;
            if (remaining > 0 && !ct.IsCancellationRequested)
            {
                var frameData = new byte[FrameSizeBytes]; // zero-initialized = silence padding
                Buffer.BlockCopy(pcmData, offset, frameData, 0, remaining);

                var sendBuffer = CreateAudioSendBuffer(frameData, frameIndex);
                _audioSocket.Send(sendBuffer);
            }

            _logger.LogDebug("Playback complete: {Frames} frames sent", frameIndex);
        }
        catch (OperationCanceledException)
        {
            _logger.LogDebug("Playback cancelled at frame {Frame}/{Total}", frameIndex, totalFrames);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Playback error at frame {Frame}", frameIndex);
        }
    }

    /// <summary>
    /// Creates an AudioSendBuffer matching the media SDK format requirements.
    /// The buffer holds a single 20ms frame of 16kHz mono 16-bit PCM.
    /// </summary>
    private static AudioSendBuffer CreateAudioSendBuffer(byte[] frameData, int frameIndex)
    {
        // Allocate unmanaged memory for the media SDK.
        var unmanagedBuf = Marshal.AllocHGlobal(frameData.Length);
        Marshal.Copy(frameData, 0, unmanagedBuf, frameData.Length);

        // Timestamp in 100-nanosecond (HNS) units from the start of playback.
        long timestampHns = (long)frameIndex * FrameDurationMs * 10_000;

        var sendBuffer = new AudioSendBuffer(
            unmanagedBuf,
            frameData.Length,
            AudioFormat.Pcm16K,
            timestampHns);

        return sendBuffer;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopPlayback();
    }
}
