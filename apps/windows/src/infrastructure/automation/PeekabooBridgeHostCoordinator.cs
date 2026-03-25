using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Automation;

/// <summary>
/// Lifecycle coordinator for the Peekaboo bridge host.
/// automation bridge that allows Peekaboo to inspect and control the UI.
///
/// Windows implementation uses a named pipe (macOS uses a Unix domain socket).
/// The Peekaboo automation framework (PeekabooAutomationKit, PeekabooBridge) is
/// macOS-only; this class provides the lifecycle shell. A future Windows Peekaboo
/// port would plug in here.
/// </summary>
internal sealed class PeekabooBridgeHostCoordinator : IHostedService
{
    internal const string PipeName = "openclaw-peekaboo";

    // legacy names kept for protocol compat
    internal static readonly IReadOnlyList<string> LegacyPipeNames =
        ["clawdbot", "clawdis", "moltbot"];

    private readonly ISettingsRepository                     _settings;
    private readonly ILogger<PeekabooBridgeHostCoordinator> _logger;
    private bool _running;

    public PeekabooBridgeHostCoordinator(
        ISettingsRepository                     settings,
        ILogger<PeekabooBridgeHostCoordinator> logger)
    {
        _settings = settings;
        _logger   = logger;
    }

    public async Task StartAsync(CancellationToken ct)
    {
        var appSettings = await _settings.LoadAsync(ct);
        await SetEnabledAsync(appSettings.PeekabooBridgeEnabled);
    }

    public Task StopAsync(CancellationToken ct)
    {
        if (!_running) return Task.CompletedTask;
        _running = false;
        _logger.LogInformation("PeekabooBridge host stopped");
        return Task.CompletedTask;
    }

    internal Task SetEnabledAsync(bool enabled)
        => enabled ? StartIfNeededAsync() : StopAsync(CancellationToken.None);

    private Task StartIfNeededAsync()
    {
        if (_running) return Task.CompletedTask;
        _running = true;

        // Unix symlinks to a socket file have
        // no equivalent for Windows named pipes; legacy pipe names are documented only.

        _logger.LogInformation(
            "PeekabooBridge host started at \\\\.\\pipe\\{PipeName} (stub — Peekaboo is macOS-only)",
            PipeName);

        // Peekaboo automation framework is not available on Windows.
        // The named pipe server is a lifecycle stub; no-op until a Windows port is available.
        return Task.CompletedTask;
    }
}
