using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Audio;

/// <summary>
/// Monitors the default microphone input level, computing exponentially-smoothed
/// normalized dB and publishing it to subscribers.
/// </summary>
internal sealed class MicLevelMonitor : IObservable<double>, IDisposable
{
    private readonly ILogger<MicLevelMonitor> _logger;
    private readonly IAudioCaptureDevice _capture;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<IObserver<double>> _observers = new();
    private readonly object _observerLock = new();

    private CancellationTokenSource? _cts;
    private bool _running;
    private double _smoothedLevel;

    // Tunables
    private const double SmoothingPrior   = 0.45;   // weight on previous smoothed value
    private const double SmoothingCurrent = 0.55;   // weight on incoming raw level
    private const float  RmsEpsilon       = 1e-12f; // prevents log10(0) for silence
    private const double DbOffset         = 50.0;   // (db + 50) / 50 normalisation addend
    private const double DbDivisor        = 50.0;   // (db + 50) / 50 normalisation divisor

    public MicLevelMonitor(ILogger<MicLevelMonitor> logger, IAudioCaptureDevice capture)
    {
        _logger  = logger;
        _capture = capture;
    }

    /// <summary>
    /// Starts audio capture and begins publishing normalized mic levels [0, 1] to subscribers.
    /// Idempotent: if already running, returns immediately without re-starting capture.
    /// Throws <see cref="InvalidOperationException"/> when no usable audio input device is present.
    /// </summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_running) return;

            _logger.LogInformation("mic level monitor start (device={HasDevice})",
                _capture.HasUsableDefaultDevice());

            if (!_capture.HasUsableDefaultDevice())
            {
                _cts = null;
                throw new InvalidOperationException("No usable audio input device available");
            }

            _cts     = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _running = true;
        }
        finally
        {
            _gate.Release();
        }

        // Fire-and-forget:
        _ = RunCaptureLoopAsync(_cts.Token);
    }

    public async Task StopAsync()
    {
        await _gate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (!_running) return;
            _cts?.Cancel();
            _cts?.Dispose();
            _cts     = null;
            _running = false;
        }
        finally
        {
            _gate.Release();
        }
    }

    public IDisposable Subscribe(IObserver<double> observer)
    {
        lock (_observerLock) _observers.Add(observer);
        return new Subscription(this, observer);
    }

    private async Task RunCaptureLoopAsync(CancellationToken ct)
    {
        try
        {
            // 16 kHz mono — sample rate does not affect RMS level calculation.
            // WASAPI manages its own internal buffer size.
            await _capture.StartCaptureAsync(
                sampleRate: 16_000,
                channels: 1,
                onBuffer: bufferBytes =>
                {
                    var level = NormalizedLevel(bufferBytes);
                    Push(level);
                    return Task.CompletedTask;
                },
                ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "mic level monitor capture error");
        }
        finally
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            _running = false;
            _gate.Release();
        }
    }

    private void Push(double level)
    {
        // Exponential smoothing — exact coefficients push(level:)
        _smoothedLevel = (_smoothedLevel * SmoothingPrior) + (level * SmoothingCurrent);
        var value = _smoothedLevel;

        IObserver<double>[] snapshot;
        lock (_observerLock) snapshot = [.. _observers];
        foreach (var observer in snapshot)
            observer.OnNext(value);
    }

    // Converts a PCM-16 LE byte buffer to a normalized mic level [0, 1].
    // Int16 samples are normalized to float32 via / 32768f.
    internal static double NormalizedLevel(byte[] buffer)
    {
        var frameCount = buffer.Length / 2; // 16-bit samples = 2 bytes each
        if (frameCount == 0) return 0.0;

        float sum = 0f;
        for (int i = 0; i < frameCount; i++)
        {
            float s = BitConverter.ToInt16(buffer, i * 2) / 32768f; // normalize to [-1, 1]
            sum += s * s;
        }

        var rms = Math.Sqrt(sum / frameCount + RmsEpsilon);
        var db  = 20.0 * Math.Log10(rms);
        return Math.Max(0.0, Math.Min(1.0, (db + DbOffset) / DbDivisor));
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts?.Dispose();
        _gate.Dispose();
    }

    private sealed class Subscription : IDisposable
    {
        private readonly MicLevelMonitor _monitor;
        private readonly IObserver<double> _observer;

        internal Subscription(MicLevelMonitor monitor, IObserver<double> observer)
        {
            _monitor  = monitor;
            _observer = observer;
        }

        public void Dispose()
        {
            lock (_monitor._observerLock)
                _monitor._observers.Remove(_observer);
        }
    }
}
