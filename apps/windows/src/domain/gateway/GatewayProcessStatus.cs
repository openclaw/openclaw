namespace OpenClawWindows.Domain.Gateway;

public enum GatewayProcessStatusKind { Stopped, Starting, Running, AttachedExisting, Failed }

public sealed class GatewayProcessStatus
{
    public GatewayProcessStatusKind Kind { get; }
    public string? Details { get; }  // details for Running/AttachedExisting, failure reason for Failed

    private GatewayProcessStatus(GatewayProcessStatusKind kind, string? details)
    {
        Kind = kind;
        Details = details;
    }

    public string Label => Kind switch
    {
        GatewayProcessStatusKind.Stopped          => "Stopped",
        GatewayProcessStatusKind.Starting         => "Starting\u2026",
        GatewayProcessStatusKind.Running when !string.IsNullOrEmpty(Details)
                                                  => $"Running ({Details})",
        GatewayProcessStatusKind.Running          => "Running",
        GatewayProcessStatusKind.AttachedExisting when !string.IsNullOrEmpty(Details)
                                                  => $"Using existing gateway ({Details})",
        GatewayProcessStatusKind.AttachedExisting => "Using existing gateway",
        GatewayProcessStatusKind.Failed           => $"Failed: {Details ?? "unknown"}",
        _                                         => "Unknown",
    };

    public static GatewayProcessStatus Stopped()                   => new(GatewayProcessStatusKind.Stopped, null);
    public static GatewayProcessStatus Starting()                  => new(GatewayProcessStatusKind.Starting, null);
    public static GatewayProcessStatus Running(string? details)    => new(GatewayProcessStatusKind.Running, details);
    public static GatewayProcessStatus AttachedExisting(string? d) => new(GatewayProcessStatusKind.AttachedExisting, d);
    public static GatewayProcessStatus Failed(string reason)       => new(GatewayProcessStatusKind.Failed, reason);
}
