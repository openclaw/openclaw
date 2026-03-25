namespace OpenClawWindows.Application.Stores;

/// <summary>
/// Exposes pending node pairing request counts for tray menu status lines.
/// </summary>
public interface INodePairingPendingMonitor
{
    int PendingCount { get; }
    int PendingRepairCount { get; }
    event EventHandler? Changed;
}

/// <summary>
/// Exposes pending device pairing request counts for tray menu status lines.
/// </summary>
public interface IDevicePairingPendingMonitor
{
    int PendingCount { get; }
    int PendingRepairCount { get; }
    event EventHandler? Changed;
}
