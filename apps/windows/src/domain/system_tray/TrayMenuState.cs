namespace OpenClawWindows.Domain.SystemTray;

public sealed record TrayMenuState
{
    public string ConnectionState { get; }
    public string? ActiveSessionLabel { get; }
    public string? UsageSummary { get; }
    public int ConnectedNodeCount { get; }
    public string? GatewayDisplayName { get; }
    public bool IsPaused { get; }

    private TrayMenuState(string connectionState, string? activeSessionLabel, string? usageSummary,
        int connectedNodeCount, string? gatewayDisplayName, bool isPaused)
    {
        ConnectionState = connectionState;
        ActiveSessionLabel = activeSessionLabel;
        UsageSummary = usageSummary;
        ConnectedNodeCount = connectedNodeCount;
        GatewayDisplayName = gatewayDisplayName;
        IsPaused = isPaused;
    }

    public static TrayMenuState Create(string connectionState, string? activeSessionLabel,
        string? usageSummary, int connectedNodeCount, string? gatewayDisplayName, bool isPaused)
    {
        Guard.Against.NullOrWhiteSpace(connectionState, nameof(connectionState));
        Guard.Against.Negative(connectedNodeCount, nameof(connectedNodeCount));

        return new(connectionState, activeSessionLabel, usageSummary,
            connectedNodeCount, gatewayDisplayName, isPaused);
    }

    public static TrayMenuState Disconnected() =>
        new("Disconnected", null, null, 0, null, false);
}
