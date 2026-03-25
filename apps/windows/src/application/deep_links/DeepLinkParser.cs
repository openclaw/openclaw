using OpenClawWindows.Domain.DeepLinks;

namespace OpenClawWindows.Application.DeepLinks;

// Routes: openclaw://agent?... and openclaw://gateway?...
internal static class DeepLinkParser
{
    internal abstract record Route;
    internal sealed record AgentRoute(AgentDeepLink Link)   : Route;
    internal sealed record GatewayRoute(GatewayConnectDeepLink Link) : Route;

    internal static Route? Parse(Uri url)
    {
        if (!string.Equals(url.Scheme, "openclaw", StringComparison.OrdinalIgnoreCase))
            return null;

        var host = url.Host.ToLowerInvariant();
        if (string.IsNullOrEmpty(host)) return null;

        var query = System.Web.HttpUtility.ParseQueryString(url.Query);

        switch (host)
        {
            case "agent":
            {
                var message = query["message"];
                if (string.IsNullOrWhiteSpace(message)) return null;

                var deliver        = ParseBool(query["deliver"]);
                var timeoutSeconds = int.TryParse(query["timeoutSeconds"], out var t) && t >= 0 ? t : (int?)null;

                return new AgentRoute(new AgentDeepLink(
                    Message:        message,
                    SessionKey:     query["sessionKey"],
                    Thinking:       query["thinking"],
                    Deliver:        deliver,
                    To:             query["to"],
                    Channel:        query["channel"],
                    TimeoutSeconds: timeoutSeconds,
                    Key:            query["key"]));
            }

            case "gateway":
            {
                var hostParam = query["host"]?.Trim();
                if (string.IsNullOrEmpty(hostParam)) return null;

                var port = int.TryParse(query["port"], out var p) ? p : 18789;
                var tls  = ParseBool(query["tls"]);

                // Non-TLS only allowed for loopback
                if (!tls && !GatewayConnectDeepLink.IsLoopbackHost(hostParam))
                    return null;

                return new GatewayRoute(new GatewayConnectDeepLink(
                    Host:     hostParam,
                    Port:     port,
                    Tls:      tls,
                    Token:    query["token"],
                    Password: query["password"]));
            }

            default:
                return null;
        }
    }

    private static bool ParseBool(string? value) =>
        value is not null && (value == "1" || value.Equals("true", StringComparison.OrdinalIgnoreCase));
}
