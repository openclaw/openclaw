using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Manages the lifecycle of the local OpenClaw gateway process.
/// </summary>
public interface IGatewayProcessManager
{
    GatewayProcessStatus Status { get; }
    string Log { get; }

    void SetActive(bool active);
    void RefreshLog();
    Task<bool> WaitForGatewayReadyAsync(TimeSpan timeout, CancellationToken ct);
}
