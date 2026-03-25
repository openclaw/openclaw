namespace OpenClawWindows.Domain.Gateway;

// Payload sent in node.connect message
public sealed record NodeConnectPayload
{
    public string PublicKeyBase64 { get; }
    public string[] Permissions { get; }

    // Commands advertised to the gateway on connect
    public static readonly string[] DefaultCommands =
    [
        "screen.record",
        "camera.snap", "camera.clip", "camera.list",
        "system.run", "system.which", "system.notify",
        "system.execApprovals.get", "system.execApprovals.set",
        "location.get",
        "canvas.present", "canvas.hide", "canvas.navigate",
        "canvas.eval", "canvas.snapshot",
        "a2ui.click", "a2ui.type", "a2ui.scroll",
    ];

    public static readonly string[] DefaultCapabilities =
        ["tool-events", "screen", "camera", "canvas"];

    private NodeConnectPayload(string publicKeyBase64, string[] permissions)
    {
        PublicKeyBase64 = publicKeyBase64;
        Permissions = permissions;
    }

    public static NodeConnectPayload Create(string publicKeyBase64, string[] permissions)
    {
        Guard.Against.NullOrWhiteSpace(publicKeyBase64, nameof(publicKeyBase64));
        Guard.Against.Null(permissions, nameof(permissions));

        return new NodeConnectPayload(publicKeyBase64, permissions);
    }
}
