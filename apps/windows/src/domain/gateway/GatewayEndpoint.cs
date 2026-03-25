using OpenClawWindows.Domain.Errors;

namespace OpenClawWindows.Domain.Gateway;

public sealed record GatewayEndpoint
{
    public Uri Uri { get; }
    public string DisplayName { get; }

    private GatewayEndpoint(Uri uri, string displayName)
    {
        Uri = uri;
        DisplayName = displayName;
    }

    public static ErrorOr<GatewayEndpoint> Create(string uri, string displayName)
    {
        Guard.Against.NullOrWhiteSpace(uri, nameof(uri));
        Guard.Against.NullOrWhiteSpace(displayName, nameof(displayName));

        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed))
            return DomainErrors.Gateway.InvalidUri(uri);

        if (parsed.Scheme is not ("ws" or "wss"))
            return DomainErrors.Gateway.InvalidUri(uri);

        return new GatewayEndpoint(parsed, displayName);
    }

    public static ErrorOr<GatewayEndpoint> FromMdns(string host, int port, string serviceName)
    {
        Guard.Against.NullOrWhiteSpace(host, nameof(host));
        Guard.Against.NullOrWhiteSpace(serviceName, nameof(serviceName));

        var uri = $"ws://{host}:{port}";
        return Create(uri, serviceName);
    }

    // Tailscale Serve exposes the gateway over HTTPS on port 443
    public static ErrorOr<GatewayEndpoint> FromTailscale(string tailnetDns, string displayName)
    {
        Guard.Against.NullOrWhiteSpace(tailnetDns, nameof(tailnetDns));
        Guard.Against.NullOrWhiteSpace(displayName, nameof(displayName));

        return Create($"wss://{tailnetDns}", displayName);
    }
}
