namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Hotword detection via Porcupine engine.
/// SPIKE-004: Picovoice SDK integration pending.
/// </summary>
public interface IPorcupineDetector
{
    bool IsAvailable { get; }
    bool IsRunning { get; }
    bool WasSuspendedByBatterySaver { get; }

    Task<ErrorOr<Success>> StartAsync(CancellationToken ct);
    Task StopAsync(CancellationToken ct);
    Task SetSensitivityAsync(float sensitivity, CancellationToken ct);
}
