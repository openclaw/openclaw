using System.Collections.Concurrent;
using System.Threading.Channels;
using Google.Protobuf;
using Microsoft.Skype.Bots.Media;

namespace OpenClaw.MsTeams.Voice;

/// <summary>
/// Handles per-speaker unmixed audio capture from the Teams media SDK.
///
/// The IAudioSocket.AudioMediaReceived callback fires at ~50 calls/sec and
/// must return as fast as possible. This class copies PCM data into lock-free
/// per-speaker ring buffers and runs background tasks to detect silence
/// boundaries and emit completed audio segments.
/// </summary>
public sealed class UnmixedAudioCapture : IDisposable
{
    /// <summary>
    /// Default silence threshold in milliseconds. A speaker is considered
    /// silent after this duration of below-threshold audio amplitude.
    /// </summary>
    public const int DefaultSilenceDurationMs = 1000;

    /// <summary>
    /// PCM amplitude threshold for silence detection. 16-bit signed samples
    /// with absolute value below this are treated as silence.
    /// Roughly -40 dBFS for 16-bit audio.
    /// </summary>
    public const short SilenceAmplitudeThreshold = 500;

    /// <summary>
    /// Sample rate: 16 kHz mono 16-bit = 32000 bytes/sec = 32 bytes/ms.
    /// </summary>
    private const int BytesPerMs = 32;

    /// <summary>
    /// Ring buffer size: 30 seconds of 16kHz mono 16-bit audio.
    /// </summary>
    private const int RingBufferCapacity = 30 * 16000 * 2;

    private readonly string _callId;
    private readonly ILogger<UnmixedAudioCapture> _logger;
    private readonly ConcurrentDictionary<uint, SpeakerState> _speakers = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly int _silenceDurationMs;
    private bool _disposed;

    /// <summary>
    /// Fires when a complete audio segment is ready (silence-terminated or
    /// buffer-full).
    /// </summary>
    public event EventHandler<UnmixedAudioSegment>? OnSegmentReady;

    public UnmixedAudioCapture(
        string callId,
        ILogger<UnmixedAudioCapture> logger,
        int silenceDurationMs = DefaultSilenceDurationMs)
    {
        _callId = callId;
        _logger = logger;
        _silenceDurationMs = silenceDurationMs;
    }

    /// <summary>
    /// IAudioSocket.AudioMediaReceived callback. MUST return fast. Copies PCM
    /// data into the per-speaker ring buffer and disposes the media buffer
    /// immediately.
    /// </summary>
    public void OnAudioReceived(AudioMediaReceivedEventArgs args)
    {
        if (_disposed) return;

        var buffer = args.Buffer;
        try
        {
            var speakerId = buffer.ActiveSpeakerId;
            var length = buffer.Length;

            if (length <= 0) return;

            var speaker = _speakers.GetOrAdd(speakerId, id =>
            {
                var state = new SpeakerState(id, RingBufferCapacity);
                // Start the background segment emitter for this speaker.
                _ = Task.Factory.StartNew(
                    () => EmitSegmentsLoop(state),
                    _cts.Token,
                    TaskCreationOptions.LongRunning,
                    TaskScheduler.Default);
                _logger.LogDebug("New speaker detected: {SpeakerId}", id);
                return state;
            });

            // Copy audio data from the unmanaged buffer into the ring buffer.
            var data = new byte[length];
            System.Runtime.InteropServices.Marshal.Copy(buffer.Data, data, 0, (int)length);
            speaker.Ring.Write(data);
            speaker.LastWriteTime = Environment.TickCount64;
        }
        finally
        {
            // CRITICAL: AudioMediaBuffer must be disposed promptly to avoid
            // exhausting the media platform buffer pool.
            buffer.Dispose();
        }
    }

    /// <summary>
    /// Background loop that reads from a speaker's ring buffer, detects
    /// silence, and emits completed audio segments.
    /// </summary>
    private async Task EmitSegmentsLoop(SpeakerState speaker)
    {
        var segmentBuffer = new MemoryStream();
        var silentSamples = 0;
        var silenceSampleThreshold = (_silenceDurationMs * 16000) / 1000; // samples, not bytes

        _logger.LogDebug(
            "Segment emitter started for speaker {SpeakerId}, silence threshold: {Ms}ms ({Samples} samples)",
            speaker.SpeakerId, _silenceDurationMs, silenceSampleThreshold);

        try
        {
            var readBuf = new byte[640]; // 20ms frame: 16kHz * 2 bytes * 20ms / 1000 = 640 bytes

            while (!_cts.Token.IsCancellationRequested)
            {
                int bytesRead = speaker.Ring.Read(readBuf);

                if (bytesRead == 0)
                {
                    // No data available. Check if speaker has been silent for
                    // extended period and emit partial segment if we have data.
                    var elapsed = Environment.TickCount64 - speaker.LastWriteTime;
                    if (elapsed > _silenceDurationMs && segmentBuffer.Length > 0)
                    {
                        EmitSegment(speaker, segmentBuffer, isFinal: true);
                        segmentBuffer = new MemoryStream();
                        silentSamples = 0;
                    }

                    // Yield to avoid busy-spinning when no data arrives.
                    await Task.Delay(10, _cts.Token);
                    continue;
                }

                // Write audio to the segment accumulation buffer.
                segmentBuffer.Write(readBuf, 0, bytesRead);

                // Silence detection: analyze the PCM samples in this chunk.
                bool chunkIsSilent = IsSilent(readBuf.AsSpan(0, bytesRead));

                if (chunkIsSilent)
                {
                    silentSamples += bytesRead / 2; // 2 bytes per sample
                }
                else
                {
                    silentSamples = 0;
                }

                // If we've accumulated enough silence, emit the segment.
                if (silentSamples >= silenceSampleThreshold && segmentBuffer.Length > 0)
                {
                    // Trim trailing silence from the segment. Keep a small
                    // amount of trailing silence for natural-sounding ends.
                    var trailKeepBytes = Math.Min(100 * BytesPerMs, segmentBuffer.Length); // keep ~100ms
                    EmitSegment(speaker, segmentBuffer, isFinal: true);
                    segmentBuffer = new MemoryStream();
                    silentSamples = 0;
                }

                // Safety: if the segment exceeds 30 seconds, force-emit.
                if (segmentBuffer.Length >= RingBufferCapacity)
                {
                    EmitSegment(speaker, segmentBuffer, isFinal: false);
                    segmentBuffer = new MemoryStream();
                    silentSamples = 0;
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Segment emitter failed for speaker {SpeakerId}", speaker.SpeakerId);
        }
        finally
        {
            // Emit any remaining data.
            if (segmentBuffer.Length > 0)
            {
                EmitSegment(speaker, segmentBuffer, isFinal: true);
            }
            segmentBuffer.Dispose();
        }
    }

    /// <summary>
    /// Checks whether a PCM buffer contains only silence (all samples below threshold).
    /// </summary>
    private static bool IsSilent(ReadOnlySpan<byte> pcm)
    {
        // 16-bit signed little-endian PCM. Process two bytes at a time.
        if (pcm.Length < 2) return true;

        int sampleCount = pcm.Length / 2;
        for (int i = 0; i < sampleCount; i++)
        {
            int offset = i * 2;
            short sample = (short)(pcm[offset] | (pcm[offset + 1] << 8));
            if (Math.Abs(sample) > SilenceAmplitudeThreshold)
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>
    /// Emits a completed audio segment to subscribers.
    /// </summary>
    private void EmitSegment(SpeakerState speaker, MemoryStream buffer, bool isFinal)
    {
        var pcmBytes = buffer.ToArray();
        var durationMs = (uint)(pcmBytes.Length / BytesPerMs);

        if (durationMs == 0) return;

        var segment = new UnmixedAudioSegment
        {
            CallId = _callId,
            SpeakerId = speaker.SpeakerId,
            DurationMs = durationMs,
            PcmData = ByteString.CopyFrom(pcmBytes),
            IsFinal = isFinal,
        };

        _logger.LogDebug(
            "Emitting segment for speaker {SpeakerId}: {Duration}ms, final={Final}, bytes={Bytes}",
            speaker.SpeakerId, durationMs, isFinal, pcmBytes.Length);

        OnSegmentReady?.Invoke(this, segment);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cts.Cancel();
        _cts.Dispose();
    }

    /// <summary>
    /// Per-speaker state tracking: ring buffer and timing info.
    /// </summary>
    private sealed class SpeakerState
    {
        public uint SpeakerId { get; }
        public RingBuffer Ring { get; }
        public long LastWriteTime { get; set; }

        public SpeakerState(uint speakerId, int capacity)
        {
            SpeakerId = speakerId;
            Ring = new RingBuffer(capacity);
            LastWriteTime = Environment.TickCount64;
        }
    }
}

/// <summary>
/// Lock-free single-producer/single-consumer ring buffer for PCM audio data.
///
/// Write operations (from the IAudioSocket callback thread) and read operations
/// (from the background segment emitter thread) are designed to operate without
/// locks by using Volatile reads/writes on the head and tail positions.
/// </summary>
public sealed class RingBuffer
{
    private readonly byte[] _buffer;
    private readonly int _capacity;
    private volatile int _writePos;
    private volatile int _readPos;

    /// <summary>
    /// Creates a ring buffer with the specified capacity in bytes.
    /// </summary>
    public RingBuffer(int capacity)
    {
        _capacity = capacity;
        _buffer = new byte[capacity];
        _writePos = 0;
        _readPos = 0;
    }

    /// <summary>
    /// Number of bytes available to read.
    /// </summary>
    public int Available
    {
        get
        {
            int w = Volatile.Read(ref _writePos);
            int r = Volatile.Read(ref _readPos);
            int avail = w - r;
            if (avail < 0) avail += _capacity;
            return avail;
        }
    }

    /// <summary>
    /// Number of bytes of free space available for writing.
    /// </summary>
    public int FreeSpace => _capacity - 1 - Available;

    /// <summary>
    /// Writes data into the ring buffer. If there is insufficient space, the
    /// oldest data is overwritten (the read position advances). This ensures the
    /// fast callback path never blocks.
    /// </summary>
    /// <param name="data">Source data to write.</param>
    public void Write(ReadOnlySpan<byte> data)
    {
        int len = data.Length;
        if (len == 0) return;
        if (len >= _capacity)
        {
            // Data exceeds buffer -- write only the tail portion.
            data = data.Slice(len - _capacity + 1);
            len = data.Length;
        }

        int w = Volatile.Read(ref _writePos);
        int r = Volatile.Read(ref _readPos);

        // Check if we need to advance the read pointer (overwrite oldest data).
        int available = w >= r ? w - r : _capacity - r + w;
        int freeSpace = _capacity - 1 - available;
        if (len > freeSpace)
        {
            int advance = len - freeSpace;
            Volatile.Write(ref _readPos, (r + advance) % _capacity);
        }

        // Write data, handling wrap-around.
        int firstChunk = Math.Min(len, _capacity - w);
        data.Slice(0, firstChunk).CopyTo(_buffer.AsSpan(w, firstChunk));

        if (firstChunk < len)
        {
            data.Slice(firstChunk).CopyTo(_buffer.AsSpan(0, len - firstChunk));
        }

        Volatile.Write(ref _writePos, (w + len) % _capacity);
    }

    /// <summary>
    /// Reads up to <paramref name="destination"/> length bytes from the ring
    /// buffer. Returns the number of bytes actually read.
    /// </summary>
    /// <param name="destination">Buffer to read into.</param>
    /// <returns>Number of bytes read (0 if buffer is empty).</returns>
    public int Read(Span<byte> destination)
    {
        int r = Volatile.Read(ref _readPos);
        int w = Volatile.Read(ref _writePos);

        int available = w >= r ? w - r : _capacity - r + w;
        if (available == 0) return 0;

        int toRead = Math.Min(available, destination.Length);

        // Read data, handling wrap-around.
        int firstChunk = Math.Min(toRead, _capacity - r);
        _buffer.AsSpan(r, firstChunk).CopyTo(destination);

        if (firstChunk < toRead)
        {
            _buffer.AsSpan(0, toRead - firstChunk).CopyTo(destination.Slice(firstChunk));
        }

        Volatile.Write(ref _readPos, (r + toRead) % _capacity);
        return toRead;
    }

    /// <summary>
    /// Resets the buffer, discarding all data.
    /// </summary>
    public void Clear()
    {
        Volatile.Write(ref _readPos, 0);
        Volatile.Write(ref _writePos, 0);
    }
}
