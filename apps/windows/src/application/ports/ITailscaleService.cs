namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Port for Tailscale status detection and integration.
/// </summary>
public interface ITailscaleService
{
    bool IsInstalled { get; }
    bool IsRunning { get; }
    string? TailscaleHostname { get; }
    string? TailscaleIP { get; }
    string? StatusError { get; }

    // Fires when TailscaleIP changes — consumer can trigger gateway endpoint refresh
    event EventHandler? IPChanged;

    Task CheckStatusAsync(CancellationToken ct = default);
    void OpenTailscaleApp();
    void OpenDownloadPage();
    void OpenSetupGuide();
}
