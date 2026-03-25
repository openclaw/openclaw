using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.VoiceWake;

// SPIKE-004 BLOCKED: Porcupine .NET SDK + ARM64 compatibility not yet verified.
// This adapter provides the full interface surface so the DI graph compiles.
// Replace the body once SPIKE-004 is resolved.
internal sealed class PorcupineWakeWordAdapter : IPorcupineDetector
{
    private readonly ILogger<PorcupineWakeWordAdapter> _logger;
    private bool _running;

    public PorcupineWakeWordAdapter(ILogger<PorcupineWakeWordAdapter> logger)
    {
        _logger = logger;
    }

    public bool IsAvailable => false; // SPIKE-004 not yet resolved

    public bool IsRunning => _running;

    public bool WasSuspendedByBatterySaver => false;

    public Task<ErrorOr<Success>> StartAsync(CancellationToken ct)
    {
        _logger.LogWarning(
            "Porcupine wake-word detection is not yet implemented (SPIKE-004 — " +
            "Porcupine .NET SDK + ARM64 verification pending).");
        return Task.FromResult<ErrorOr<Success>>(
            Error.Failure("SPIKE_004", "Porcupine SDK not yet integrated"));
    }

    public Task StopAsync(CancellationToken ct)
    {
        _running = false;
        return Task.CompletedTask;
    }

    public Task SetSensitivityAsync(float sensitivity, CancellationToken ct)
    {
        _logger.LogDebug("SetSensitivity({S}) — no-op until SPIKE-004 resolved", sensitivity);
        return Task.CompletedTask;
    }
}
