using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wave;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Audio;

// Raw audio capture via NAudio.WasapiCapture.
// combined with the capture logic. Implements IMMNotificationClient so the caller
// receives DefaultDeviceChanged without a separate observer object.
internal sealed class NAudioCaptureAdapter : IAudioCaptureDevice, IMMNotificationClient, IDisposable
{
    private readonly ILogger<NAudioCaptureAdapter> _logger;

    // Kept alive for the application lifetime — used for HasUsableDefaultDevice() and
    // IMMNotificationClient registration, mirroring the CoreAudio system-object listeners
    // in AudioInputDeviceObserver.start().
    private readonly MMDeviceEnumerator _enumerator = new();

    private WasapiCapture? _capture;
    private bool _capturing;

    public event EventHandler? DefaultDeviceChanged;

    // Lazily init AudioGraph to avoid switching BT headphones to headset profile at startup
    public NAudioCaptureAdapter(ILogger<NAudioCaptureAdapter> logger)
    {
        _logger = logger;
        _enumerator.RegisterEndpointNotificationCallback(this);
    }

    public bool IsCapturing => _capturing;

    // Returns true when a working microphone is present and active.
    public bool HasUsableDefaultDevice()
    {
        try
        {
            using var ep = _enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
            return ep.State == DeviceState.Active;
        }
        catch { return false; }
    }

    public async Task<bool> IsPermissionGrantedAsync(CancellationToken ct)
    {
        // WASAPI does not have a runtime permission prompt on Windows;
        // access is controlled by system settings (Privacy > Microphone).
        // Try opening a capture device — failure means permission is denied.
        try
        {
            using var probe = new WasapiCapture();
            return true;
        }
        catch
        {
            return false;
        }
    }

    public Task<ErrorOr<Success>> OpenAsync(CancellationToken ct)
    {
        try
        {
            _capture = new WasapiCapture();
            return Task.FromResult<ErrorOr<Success>>(Result.Success);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to open audio capture device");
            return Task.FromResult<ErrorOr<Success>>(
                Error.Failure("PERMISSION_MISSING: microphone"));
        }
    }

    public Task CloseAsync(CancellationToken ct)
    {
        _capture?.Dispose();
        _capture = null;
        return Task.CompletedTask;
    }

    public async Task StartCaptureAsync(
        int sampleRate, int channels, Func<byte[], Task> onBuffer, CancellationToken ct)
    {
        if (_capture is null)
        {
            var openResult = await OpenAsync(ct);
            if (openResult.IsError)
                return;
        }

        _capture!.WaveFormat = new WaveFormat(sampleRate, 16, channels);

        _capture.DataAvailable += async (_, e) =>
        {
            var pcm = e.Buffer[..e.BytesRecorded];
            await onBuffer(pcm);
        };

        _capture.StartRecording();
        _capturing = true;

        // Keep open until cancelled
        await Task.Delay(Timeout.Infinite, ct).ConfigureAwait(false);
    }

    public Task StopCaptureAsync(CancellationToken ct)
    {
        _capture?.StopRecording();
        _capturing = false;
        return Task.CompletedTask;
    }

    // ── IMMNotificationClient ─────────────────────────────────────────────────

    void IMMNotificationClient.OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow != DataFlow.Capture) return;
        _logger.LogInformation("Audio default input changed deviceId={Id}", defaultDeviceId);
        DefaultDeviceChanged?.Invoke(this, EventArgs.Empty);
    }

    void IMMNotificationClient.OnDeviceStateChanged(string deviceId, DeviceState newState)
    {
        // Active ↔ inactive transition may change HasUsableDefaultDevice() result
        DefaultDeviceChanged?.Invoke(this, EventArgs.Empty);
    }

    void IMMNotificationClient.OnDeviceAdded(string deviceId) { }
    void IMMNotificationClient.OnDeviceRemoved(string deviceId) { }
    void IMMNotificationClient.OnPropertyValueChanged(string deviceId, PropertyKey key) { }

    public void Dispose()
    {
        _enumerator.UnregisterEndpointNotificationCallback(this);
        _capture?.Dispose();
        _enumerator.Dispose();
    }
}
