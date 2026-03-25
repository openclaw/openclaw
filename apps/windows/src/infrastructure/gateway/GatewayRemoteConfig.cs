using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Infrastructure.Gateway;

internal static class GatewayRemoteConfig
{
    // Tunables
    private const int DefaultWsPort  = 18789;
    private const int DefaultWssPort = 443;

    internal static RemoteTransport ResolveTransport(Dictionary<string, object?> root)
    {
        var remote = RemoteSection(root);
        if (remote?.GetValueOrDefault("transport") is not string raw)
            return RemoteTransport.Ssh;

        var trimmed = raw.Trim().ToLowerInvariant();
        return trimmed == "direct" ? RemoteTransport.Direct : RemoteTransport.Ssh;
    }

    internal static string? ResolveUrlString(Dictionary<string, object?> root)
    {
        var remote = RemoteSection(root);
        if (remote?.GetValueOrDefault("url") is not string raw)
            return null;

        var trimmed = raw.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    internal static Uri? ResolveGatewayUrl(Dictionary<string, object?> root)
    {
        var raw = ResolveUrlString(root);
        return raw is null ? null : NormalizeGatewayUrl(raw);
    }

    internal static string? NormalizeGatewayUrlString(string raw)
        => NormalizeGatewayUrl(raw)?.AbsoluteUri;

    internal static Uri? NormalizeGatewayUrl(string raw)
    {
        var trimmed = raw.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var url)) return null;

        var scheme = url.Scheme.ToLowerInvariant();
        if (scheme != "ws" && scheme != "wss") return null;

        var host = url.Host.Trim();
        if (string.IsNullOrEmpty(host)) return null;

        // ws:// is only allowed for loopback hosts
        if (scheme == "ws" && !LoopbackHost.IsLoopbackHost(host))
            return null;

        // Inject default port for unqualified ws://
        // Use UriComponents.Port (not Uri.Port) because in .NET ws:// maps to port 80 by default,
        // so Uri.Port returns 80 even when no port was specified in the string.
        if (scheme == "ws" && !HasExplicitPort(url))
            return new UriBuilder(url) { Port = DefaultWsPort }.Uri;

        return url;
    }

    internal static int? DefaultPort(Uri url)
    {
        // Mirror Swift: if let port = url.port { return port } → explicit port takes precedence
        // Use UriComponents.Port which returns "" when port was not explicitly given.
        var portStr = url.GetComponents(UriComponents.Port, UriFormat.Unescaped);
        if (!string.IsNullOrEmpty(portStr) && int.TryParse(portStr, out var explicitPort))
            return explicitPort;

        return url.Scheme.ToLowerInvariant() switch
        {
            "wss" => DefaultWssPort,
            "ws"  => DefaultWsPort,
            _     => null,
        };
    }

    private static bool HasExplicitPort(Uri url)
    {
        var portStr = url.GetComponents(UriComponents.Port, UriFormat.Unescaped);
        return !string.IsNullOrEmpty(portStr);
    }

    private static Dictionary<string, object?>? RemoteSection(Dictionary<string, object?> root)
    {
        if (root.GetValueOrDefault("gateway") is not Dictionary<string, object?> gateway)
            return null;
        return gateway.GetValueOrDefault("remote") as Dictionary<string, object?>;
    }
}
