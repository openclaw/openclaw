namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Raw audio capture for VAD and STT input.
/// Implemented by NAudioCaptureAdapter (NAudio).
/// </summary>
public interface IAudioCaptureDevice
{
    bool IsCapturing { get; }

    // Returns true when a working microphone is present and active.
    // Use as preflight before OpenAsync to avoid errors on headless machines.
    bool HasUsableDefaultDevice();

    // Fires when the system default capture device changes or a device transitions active/inactive.
    event EventHandler? DefaultDeviceChanged;

    Task<bool> IsPermissionGrantedAsync(CancellationToken ct);
    Task<ErrorOr<Success>> OpenAsync(CancellationToken ct);
    Task CloseAsync(CancellationToken ct);
    Task StartCaptureAsync(int sampleRate, int channels, Func<byte[], Task> onBuffer, CancellationToken ct);
    Task StopCaptureAsync(CancellationToken ct);
}
