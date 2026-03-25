// Mirrors GatewayConfig.swift: config struct + loadGatewayConfig() loading ~/.openclaw/openclaw.json.
using System.Text.Json.Nodes;

namespace OpenClawWindows.CLI;

internal sealed record GatewayConfig(
    string? Mode,
    string? Bind,
    int? Port,
    string? Token,
    string? Password,
    string? RemoteUrl,
    string? RemoteToken,
    string? RemotePassword);

internal static class GatewayConfigLoader
{
    private static readonly GatewayConfig Empty = new(null, null, null, null, null, null, null, null);

    internal static GatewayConfig Load()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var path = Path.Combine(home, ".openclaw", "openclaw.json");

        if (!File.Exists(path)) return Empty;

        try
        {
            var json = File.ReadAllText(path);
            var doc = JsonNode.Parse(json);
            if (doc == null) return Empty;

            var gateway = doc["gateway"];
            if (gateway == null) return Empty;

            var auth = gateway["auth"];
            var remote = gateway["remote"];

            return new GatewayConfig(
                Mode:           gateway["mode"]?.GetValue<string>(),
                Bind:           gateway["bind"]?.GetValue<string>(),
                Port:           TryGetInt(gateway["port"]),
                Token:          auth?["token"]?.GetValue<string>(),
                Password:       auth?["password"]?.GetValue<string>(),
                RemoteUrl:      remote?["url"]?.GetValue<string>(),
                RemoteToken:    remote?["token"]?.GetValue<string>(),
                RemotePassword: remote?["password"]?.GetValue<string>());
        }
        catch { return Empty; }
    }

    private static int? TryGetInt(JsonNode? node)
    {
        if (node == null) return null;
        try
        {
            return node.GetValueKind() switch
            {
                System.Text.Json.JsonValueKind.Number => node.GetValue<int>(),
                System.Text.Json.JsonValueKind.String =>
                    int.TryParse(node.GetValue<string>()?.Trim(), out var n) ? n : null,
                _ => null,
            };
        }
        catch { return null; }
    }
}
