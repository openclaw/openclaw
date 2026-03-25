// Mirrors ConnectCommand.swift: WebSocket connect + health RPC probe.
// Windows equivalent of GatewayChannelActor: uses ClientWebSocket directly.
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace OpenClawWindows.CLI;

internal sealed class ConnectOptions
{
    internal string?   Url         { get; private set; }
    internal string?   Token       { get; private set; }
    internal string?   Password    { get; private set; }
    internal string?   Mode        { get; private set; }
    internal int       TimeoutMs   { get; private set; } = 15000;
    internal bool      Json        { get; private set; }
    internal bool      Probe       { get; private set; }
    internal string    ClientId    { get; private set; } = "openclaw-control-ui";
    internal string    ClientMode  { get; private set; } = "ui";
    internal string?   DisplayName { get; private set; }
    internal string    Role        { get; private set; } = "operator";
    internal string[]  Scopes      { get; private set; } = GatewayScopes.DefaultOperatorConnectScopes;
    internal bool      Help        { get; private set; }

    // Mirrors ConnectOptions.parse() in ConnectCommand.swift.
    internal static ConnectOptions Parse(string[] args)
    {
        var opts = new ConnectOptions();
        var i = 0;
        while (i < args.Length)
        {
            switch (args[i])
            {
                case "-h":
                case "--help":
                    opts.Help = true;
                    break;
                case "--json":
                    opts.Json = true;
                    break;
                case "--probe":
                    opts.Probe = true;
                    break;
                case "--url" when i + 1 < args.Length:
                    opts.Url = args[++i].Trim();
                    break;
                case "--token" when i + 1 < args.Length:
                    opts.Token = args[++i].Trim();
                    break;
                case "--password" when i + 1 < args.Length:
                    opts.Password = args[++i].Trim();
                    break;
                case "--mode" when i + 1 < args.Length:
                    opts.Mode = args[++i].Trim();
                    break;
                case "--timeout" when i + 1 < args.Length:
                    if (int.TryParse(args[++i].Trim(), out var ms))
                        opts.TimeoutMs = Math.Max(250, ms);
                    break;
                case "--client-id" when i + 1 < args.Length:
                    opts.ClientId = args[++i].Trim();
                    break;
                case "--client-mode" when i + 1 < args.Length:
                    opts.ClientMode = args[++i].Trim();
                    break;
                case "--display-name" when i + 1 < args.Length:
                    opts.DisplayName = args[++i].Trim();
                    break;
                case "--role" when i + 1 < args.Length:
                    opts.Role = args[++i].Trim();
                    break;
                case "--scopes" when i + 1 < args.Length:
                    opts.Scopes = args[++i].Split(',')
                        .Select(s => s.Trim()).Where(s => s.Length > 0).ToArray();
                    break;
                default:
                    break;
            }
            i++;
        }
        return opts;
    }
}

// Mirrors ConnectOutput in ConnectCommand.swift.
internal sealed class ConnectOutput
{
    [JsonPropertyName("status")]     public required string    Status     { get; init; }
    [JsonPropertyName("url")]        public required string    Url        { get; init; }
    [JsonPropertyName("mode")]       public required string    Mode       { get; init; }
    [JsonPropertyName("role")]       public required string    Role       { get; init; }
    [JsonPropertyName("clientId")]   public required string    ClientId   { get; init; }
    [JsonPropertyName("clientMode")] public required string    ClientMode { get; init; }
    [JsonPropertyName("scopes")]     public required string[]  Scopes     { get; init; }
    [JsonPropertyName("snapshot")]   public          JsonNode? Snapshot   { get; init; }
    [JsonPropertyName("health")]     public          JsonNode? Health     { get; init; }
    [JsonPropertyName("error")]      public          string?   Error      { get; init; }
}

internal static class ConnectCommand
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented               = true,
    };

    internal static async Task RunAsync(string[] args)
    {
        var opts = ConnectOptions.Parse(args);
        if (opts.Help)
        {
            Console.WriteLine("""
                openclaw-win connect

                Usage:
                  openclaw-win connect [--url <ws://host:port>] [--token <token>] [--password <password>]
                                       [--mode <local|remote>] [--timeout <ms>] [--probe] [--json]
                                       [--client-id <id>] [--client-mode <mode>] [--display-name <name>]
                                       [--role <role>] [--scopes <a,b,c>]

                Options:
                  --url <url>        Gateway WebSocket URL (overrides config)
                  --token <token>    Gateway token (if required)
                  --password <pw>    Gateway password (if required)
                  --mode <mode>      Resolve from config: local|remote (default: config or local)
                  --timeout <ms>     Request timeout (default: 15000)
                  --probe            Force a fresh health probe
                  --json             Emit JSON
                  --client-id <id>   Override client id (default: cli)
                  --client-mode <m>  Override client mode (default: ui)
                  --display-name <n> Override display name
                  --role <role>      Override role (default: operator)
                  --scopes <a,b,c>   Override scopes list
                  -h, --help         Show help
                """);
            return;
        }

        var config = GatewayConfigLoader.Load();
        try
        {
            var endpoint = ResolveGatewayEndpoint(opts, config);
            var displayName = opts.DisplayName
                              ?? Environment.MachineName
                              ?? "OpenClaw Windows Debug CLI";

            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(opts.TimeoutMs));
            using var client = new GatewayCliClient();

            var (snapshot, health) = await client.ConnectAndProbeAsync(
                endpoint.Url,
                endpoint.Token,
                endpoint.Password,
                opts.ClientId,
                opts.ClientMode,
                opts.Role,
                opts.Scopes,
                displayName,
                opts.Probe,
                cts.Token);

            var output = new ConnectOutput
            {
                Status     = "ok",
                Url        = endpoint.Url.ToString(),
                Mode       = endpoint.Mode,
                Role       = opts.Role,
                ClientId   = opts.ClientId,
                ClientMode = opts.ClientMode,
                Scopes     = opts.Scopes,
                Snapshot   = snapshot,
                Health     = health,
                Error      = null,
            };
            PrintOutput(output, opts.Json);
        }
        catch (Exception ex)
        {
            var fallback    = BestEffortEndpoint(opts, config);
            var modeLabel   = (opts.Mode ?? config.Mode ?? "local").ToLowerInvariant();
            var output = new ConnectOutput
            {
                Status     = "error",
                Url        = fallback?.Url.ToString() ?? "unknown",
                Mode       = fallback?.Mode ?? modeLabel,
                Role       = opts.Role,
                ClientId   = opts.ClientId,
                ClientMode = opts.ClientMode,
                Scopes     = opts.Scopes,
                Snapshot   = null,
                Health     = null,
                Error      = ex.Message,
            };
            PrintOutput(output, opts.Json);
            Environment.Exit(1);
        }
    }

    // Mirrors resolveGatewayEndpoint() in ConnectCommand.swift.
    private static GatewayEndpoint ResolveGatewayEndpoint(ConnectOptions opts, GatewayConfig config)
    {
        var resolvedMode = (opts.Mode ?? config.Mode ?? "local").ToLowerInvariant();

        if (!string.IsNullOrWhiteSpace(opts.Url))
            return BuildEndpoint(opts.Url, opts, resolvedMode, config);

        if (resolvedMode == "remote")
        {
            if (string.IsNullOrWhiteSpace(config.RemoteUrl))
                throw new InvalidOperationException("gateway.remote.url is missing");
            return BuildEndpoint(config.RemoteUrl, opts, resolvedMode, config);
        }

        var port = config.Port ?? 18789;
        var host = NetworkHelpers.ResolveLocalHost(config.Bind);
        return new GatewayEndpoint(
            new Uri($"ws://{host}:{port}"),
            ResolvedToken(opts.Token, resolvedMode, config),
            ResolvedPassword(opts.Password, resolvedMode, config),
            resolvedMode);
    }

    private static GatewayEndpoint? BestEffortEndpoint(ConnectOptions opts, GatewayConfig config)
    {
        try { return ResolveGatewayEndpoint(opts, config); }
        catch { return null; }
    }

    private static GatewayEndpoint BuildEndpoint(
        string raw, ConnectOptions opts, string mode, GatewayConfig config)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var url))
            throw new InvalidOperationException($"invalid url: {raw}");
        return new GatewayEndpoint(
            url,
            ResolvedToken(opts.Token, mode, config),
            ResolvedPassword(opts.Password, mode, config),
            mode);
    }

    private static string? ResolvedToken(string? cliToken, string mode, GatewayConfig config)
    {
        if (!string.IsNullOrEmpty(cliToken)) return cliToken;
        return mode == "remote" ? config.RemoteToken : config.Token;
    }

    private static string? ResolvedPassword(string? cliPassword, string mode, GatewayConfig config)
    {
        if (!string.IsNullOrEmpty(cliPassword)) return cliPassword;
        return mode == "remote" ? config.RemotePassword : config.Password;
    }

    // Mirrors printConnectOutput() in ConnectCommand.swift.
    private static void PrintOutput(ConnectOutput output, bool json)
    {
        if (json)
        {
            Console.WriteLine(JsonSerializer.Serialize(output, JsonOpts));
            return;
        }

        Console.WriteLine("OpenClaw Windows Gateway Connect");
        Console.WriteLine($"Status: {output.Status}");
        Console.WriteLine($"URL: {output.Url}");
        Console.WriteLine($"Mode: {output.Mode}");
        Console.WriteLine($"Client: {output.ClientId} ({output.ClientMode})");
        Console.WriteLine($"Role: {output.Role}");
        Console.WriteLine($"Scopes: {string.Join(", ", output.Scopes)}");

        if (output.Snapshot != null)
        {
            var protocol_ = output.Snapshot["protocol"]?.GetValue<int>();
            var version   = output.Snapshot["server"]?["version"]?.GetValue<string>();
            if (protocol_.HasValue) Console.WriteLine($"Protocol: {protocol_}");
            if (version != null)    Console.WriteLine($"Server: {version}");
        }
        if (output.Health != null)
        {
            var ok = output.Health["ok"]?.GetValue<bool>();
            Console.WriteLine(ok.HasValue ? $"Health: {(ok.Value ? "ok" : "error")}" : "Health: received");
        }
        if (output.Error != null)
            Console.WriteLine($"Error: {output.Error}");
    }
}

// Local record matching GatewayEndpoint.swift minimal shape.
internal sealed record GatewayEndpoint(Uri Url, string? Token, string? Password, string Mode);

// Minimal WebSocket client for connect+probe — mirrors GatewayChannelActor behavior.
internal sealed class GatewayCliClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly ClientWebSocket _ws = new();

    internal async Task<(JsonNode? Snapshot, JsonNode? Health)> ConnectAndProbeAsync(
        Uri url,
        string? token,
        string? password,
        string clientId,
        string clientMode,
        string role,
        string[] scopes,
        string displayName,
        bool probe,
        CancellationToken ct)
    {
        _ws.Options.SetRequestHeader("User-Agent", "openclaw-win/dev");
        await _ws.ConnectAsync(url, ct);

        JsonNode? snapshot = null;

        // Build connect params — mirrors sendConnect() in GatewayWizardClient.
        var osVersion = Environment.OSVersion.Version;
        var platform  = $"windows {osVersion.Major}.{osVersion.Minor}.{osVersion.Build}";

        var clientObj = new JsonObject
        {
            ["id"]           = clientId,
            ["displayName"]  = displayName,
            ["version"]      = "dev",
            ["platform"]     = platform,
            ["deviceFamily"] = "PC",
            ["mode"]         = clientMode,
            ["instanceId"]   = Guid.NewGuid().ToString(),
        };

        var connectParams = new JsonObject
        {
            ["minProtocol"] = GatewayProtocol.Version,
            ["maxProtocol"] = GatewayProtocol.Version,
            ["client"]      = clientObj,
            ["caps"]        = new JsonArray(),
            ["locale"]      = System.Globalization.CultureInfo.CurrentCulture.Name,
            ["userAgent"]   = $"openclaw-win/{osVersion}",
            ["role"]        = role,
            ["scopes"]      = JsonValue.Create(scopes)!,
        };

        if (!string.IsNullOrEmpty(token))
            connectParams["auth"] = new JsonObject { ["token"] = token };
        else if (!string.IsNullOrEmpty(password))
            connectParams["auth"] = new JsonObject { ["password"] = password };

        // Wait for connect.challenge nonce (0.75 s timeout) before sending connect.
        using var challengeCts = new CancellationTokenSource(TimeSpan.FromSeconds(0.75));
        using var linked       = CancellationTokenSource.CreateLinkedTokenSource(challengeCts.Token, ct);
        try
        {
            while (true)
            {
                var frame = await ReceiveFrameAsync(linked.Token);
                if (frame is GatewayFrame.Evt evt && evt.Frame.Event == "connect.challenge")
                    break;
            }
        }
        catch (OperationCanceledException) when (challengeCts.IsCancellationRequested)
        {
            // Gateway did not send challenge — proceed without nonce (pre-v3 compat).
        }

        var connectId = Guid.NewGuid().ToString();
        await SendRequestAsync(connectId, "connect", connectParams, ct);

        // Wait for connect response — captures hello-ok as snapshot.
        while (true)
        {
            var frame = await ReceiveFrameAsync(ct);
            if (frame is GatewayFrame.Res res && res.Frame.Id == connectId)
            {
                if (!res.Frame.Ok)
                {
                    var msg = res.Frame.Error?["message"]?.GetValue<string>() ?? "gateway connect failed";
                    throw new InvalidOperationException(msg);
                }
                snapshot = res.Frame.Payload;
                break;
            }
        }

        // health RPC — mirrors channel.request("health", params, timeoutMs).
        var healthParams = probe ? new JsonObject { ["probe"] = true } : null;
        var healthId     = Guid.NewGuid().ToString();
        await SendRequestAsync(healthId, "health", healthParams, ct);

        while (true)
        {
            var frame = await ReceiveFrameAsync(ct);
            if (frame is GatewayFrame.Res res && res.Frame.Id == healthId)
            {
                if (!res.Frame.Ok)
                {
                    var msg = res.Frame.Error?["message"]?.GetValue<string>() ?? "health error";
                    throw new InvalidOperationException(msg);
                }
                return (snapshot, res.Frame.Payload);
            }
        }
    }

    internal async Task SendRequestAsync(
        string id, string method, JsonNode? @params, CancellationToken ct)
    {
        var frame = new RequestFrame("req", id, method, @params);
        var json  = JsonSerializer.Serialize(frame, JsonOpts);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);
    }

    internal async Task<GatewayFrame> ReceiveFrameAsync(CancellationToken ct)
    {
        var buffer      = new byte[65536];
        var accumulated = new List<ArraySegment<byte>>();

        while (true)
        {
            var result = await _ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) break;
            // Copy before buffering — buffer is reused on the next ReceiveAsync call.
            accumulated.Add(new ArraySegment<byte>(buffer[..result.Count]));
            if (result.EndOfMessage) break;
        }

        var text = Encoding.UTF8.GetString(
            accumulated.SelectMany(s => s).ToArray());
        return JsonSerializer.Deserialize<GatewayFrame>(text, JsonOpts)
               ?? new GatewayFrame.Unknown("null");
    }

    internal async Task ShutdownAsync()
    {
        if (_ws.State == WebSocketState.Open)
        {
            await _ws.CloseAsync(
                WebSocketCloseStatus.NormalClosure, "client disconnect", CancellationToken.None);
        }
    }

    public void Dispose() => _ws.Dispose();
}
