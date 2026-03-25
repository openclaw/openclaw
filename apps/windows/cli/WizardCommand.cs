// Mirrors WizardCommand.swift: interactive TTY wizard + GatewayWizardClient actor.
// GatewayWizardClient — uses ClientWebSocket (mirrors URLSessionWebSocketTask on macOS).
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OpenClawWindows.CLI;

internal sealed class WizardCliOptions
{
    internal string? Url       { get; private set; }
    internal string? Token     { get; private set; }
    internal string? Password  { get; private set; }
    internal string  Mode      { get; private set; } = "local";
    internal string? Workspace { get; private set; }
    internal bool    Json      { get; private set; }
    internal bool    Help      { get; private set; }

    // Mirrors WizardCliOptions.parse() in WizardCommand.swift.
    internal static WizardCliOptions Parse(string[] args)
    {
        var opts = new WizardCliOptions();
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
                case "--workspace" when i + 1 < args.Length:
                    opts.Workspace = args[++i].Trim();
                    break;
                default:
                    break;
            }
            i++;
        }
        return opts;
    }
}

// Mirrors WizardCliError in WizardCommand.swift.
internal sealed class WizardCliException(string message) : Exception(message)
{
    internal static WizardCliException InvalidUrl(string raw)
        => new($"Invalid URL: {raw}");
    internal static WizardCliException MissingRemoteUrl()
        => new("gateway.remote.url is missing");
    internal static WizardCliException GatewayError(string msg)
        => new(msg);
    internal static WizardCliException DecodeError(string msg)
        => new(msg);
    internal static readonly WizardCliException Cancelled
        = new("Wizard canceled");
}

internal static class WizardCommand
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented               = true,
    };

    internal static async Task RunAsync(string[] args)
    {
        var opts = WizardCliOptions.Parse(args);
        if (opts.Help)
        {
            Console.WriteLine("""
                openclaw-win wizard

                Usage:
                  openclaw-win wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
                                      [--mode <local|remote>] [--workspace <path>] [--json]

                Options:
                  --url <url>        Gateway WebSocket URL (overrides config)
                  --token <token>    Gateway token (if required)
                  --password <pw>    Gateway password (if required)
                  --mode <mode>      Wizard mode (local|remote). Default: local
                  --workspace <path> Wizard workspace override
                  --json             Print raw wizard responses
                  -h, --help         Show help
                """);
            return;
        }

        var config = GatewayConfigLoader.Load();
        try
        {
            // Mirrors: guard isatty(STDIN_FILENO) != 0 else { throw .gatewayError("Wizard requires an interactive TTY.") }
            if (Console.IsInputRedirected)
                throw WizardCliException.GatewayError("Wizard requires an interactive TTY.");

            var endpoint = ResolveWizardGatewayEndpoint(opts, config);
            var client   = new GatewayWizardClient(
                endpoint.Url, endpoint.Token, endpoint.Password, opts.Json);

            await client.ConnectAsync(CancellationToken.None);
            try
            {
                await RunWizardAsync(client, opts);
            }
            finally
            {
                await client.CloseAsync();
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"wizard: {ex.Message}");
            Environment.Exit(1);
        }
    }

    // Mirrors resolveWizardGatewayEndpoint() in WizardCommand.swift.
    private static GatewayEndpoint ResolveWizardGatewayEndpoint(
        WizardCliOptions opts, GatewayConfig config)
    {
        if (!string.IsNullOrWhiteSpace(opts.Url))
        {
            if (!Uri.TryCreate(opts.Url, UriKind.Absolute, out var parsedUrl))
                throw WizardCliException.InvalidUrl(opts.Url);
            return new GatewayEndpoint(
                parsedUrl,
                ResolvedToken(opts, config),
                ResolvedPassword(opts, config),
                (config.Mode ?? "local").ToLowerInvariant());
        }

        var mode = (config.Mode ?? "local").ToLowerInvariant();
        if (mode == "remote")
        {
            if (string.IsNullOrWhiteSpace(config.RemoteUrl))
                throw WizardCliException.MissingRemoteUrl();
            if (!Uri.TryCreate(config.RemoteUrl, UriKind.Absolute, out var remoteUrl))
                throw WizardCliException.InvalidUrl(config.RemoteUrl);
            return new GatewayEndpoint(remoteUrl, ResolvedToken(opts, config),
                ResolvedPassword(opts, config), mode);
        }

        var port = config.Port ?? 18789;
        var urlStr = $"ws://127.0.0.1:{port}";
        if (!Uri.TryCreate(urlStr, UriKind.Absolute, out var localUrl))
            throw WizardCliException.InvalidUrl(urlStr);
        return new GatewayEndpoint(localUrl, ResolvedToken(opts, config),
            ResolvedPassword(opts, config), mode);
    }

    private static string? ResolvedToken(WizardCliOptions opts, GatewayConfig config)
    {
        if (!string.IsNullOrEmpty(opts.Token)) return opts.Token;
        return (config.Mode ?? "local").ToLowerInvariant() == "remote"
            ? config.RemoteToken
            : config.Token;
    }

    private static string? ResolvedPassword(WizardCliOptions opts, GatewayConfig config)
    {
        if (!string.IsNullOrEmpty(opts.Password)) return opts.Password;
        return (config.Mode ?? "local").ToLowerInvariant() == "remote"
            ? config.RemotePassword
            : config.Password;
    }

    // Mirrors runWizard() in WizardCommand.swift — wizard.start → loop wizard.next.
    private static async Task RunWizardAsync(GatewayWizardClient client, WizardCliOptions opts)
    {
        var startParams = new JsonObject();
        var mode = opts.Mode.Trim().ToLowerInvariant();
        if (mode is "local" or "remote")
            startParams["mode"] = mode;
        if (!string.IsNullOrWhiteSpace(opts.Workspace))
            startParams["workspace"] = opts.Workspace;

        var startResponse = await client.RequestAsync("wizard.start", startParams);
        var startResult   = client.DecodePayload<WizardStartResult>(startResponse);
        if (opts.Json) DumpResult(startResponse);

        var sessionId  = startResult.SessionId;
        var nextResult = new WizardNextResult(
            Done:   startResult.Done,
            Step:   startResult.Step,
            Status: startResult.Status,
            Error:  startResult.Error);

        try
        {
            while (true)
            {
                var status = WizardHelpers.WizardStatusString(nextResult.Status)
                             ?? (nextResult.Done ? "done" : "running");

                if (status == "cancelled")
                {
                    Console.WriteLine("Wizard canceled.");
                    return;
                }
                if (status == "error" || (nextResult.Done && nextResult.Error != null))
                    throw WizardCliException.GatewayError(nextResult.Error ?? "wizard error");
                if (status == "done" || nextResult.Done)
                {
                    Console.WriteLine("Wizard complete.");
                    return;
                }

                var step = WizardHelpers.DecodeWizardStep(nextResult.Step);
                if (step != null)
                {
                    var answer      = PromptAnswer(step);
                    var answerNode  = new JsonObject { ["stepId"] = step.Id };
                    if (answer != null)
                        answerNode["value"] = answer;

                    var response = await client.RequestAsync(
                        "wizard.next",
                        new JsonObject
                        {
                            ["sessionId"] = sessionId,
                            ["answer"]    = answerNode,
                        });
                    nextResult = client.DecodePayload<WizardNextResult>(response);
                    if (opts.Json) DumpResult(response);
                }
                else
                {
                    var response = await client.RequestAsync(
                        "wizard.next",
                        new JsonObject { ["sessionId"] = sessionId });
                    nextResult = client.DecodePayload<WizardNextResult>(response);
                    if (opts.Json) DumpResult(response);
                }
            }
        }
        catch (Exception ex) when (ReferenceEquals(ex, WizardCliException.Cancelled)
                                   || ex.Message == WizardCliException.Cancelled.Message)
        {
            try
            {
                await client.RequestAsync("wizard.cancel",
                    new JsonObject { ["sessionId"] = sessionId });
            }
            catch { /* best-effort cancel */ }
            throw;
        }
    }

    // Mirrors dumpResult() in WizardCommand.swift.
    private static void DumpResult(JsonNode? payload)
    {
        if (payload == null) { Console.WriteLine("{\"error\":\"missing payload\"}"); return; }
        Console.WriteLine(JsonSerializer.Serialize(payload, JsonOpts));
    }

    // Mirrors promptAnswer() in WizardCommand.swift — handles all 6 step types.
    private static JsonNode? PromptAnswer(WizardStep step)
    {
        var type = WizardHelpers.WizardStepType(step);

        if (!string.IsNullOrEmpty(step.Title))
            Console.WriteLine($"\n{step.Title}");
        if (!string.IsNullOrEmpty(step.Message))
            Console.WriteLine(step.Message);

        switch (type)
        {
            case "note":
            case "progress":
                ReadLine("Continue? (enter)");
                return null;

            case "action":
                ReadLine("Run? (enter)");
                return JsonValue.Create(true);

            case "text":
            {
                var initial = WizardHelpers.AnyCodableString(step.InitialValue);
                var prompt  = step.Placeholder ?? "Value";
                var suffix  = string.IsNullOrEmpty(initial) ? "" : $" [{initial}]";
                var value   = ReadLine($"{prompt}{suffix}");
                var trimmed = value?.Trim() ?? "";
                return JsonValue.Create(trimmed.Length == 0 ? initial : trimmed);
            }

            case "confirm":
            {
                var initial = WizardHelpers.AnyCodableBool(step.InitialValue);
                var value   = ReadLine($"Confirm? (y/n) [{(initial ? "y" : "n")}]");
                var trimmed = value?.Trim().ToLowerInvariant() ?? "";
                if (trimmed.Length == 0) return JsonValue.Create(initial);
                return JsonValue.Create(trimmed is "y" or "yes" or "true");
            }

            case "select":
                return PromptSelect(step);

            case "multiselect":
                return PromptMultiSelect(step);

            default:
                ReadLine("Continue? (enter)");
                return null;
        }
    }

    // Mirrors promptSelect() in WizardCommand.swift.
    private static JsonNode? PromptSelect(WizardStep step)
    {
        var options = WizardHelpers.ParseWizardOptions(step.Options);
        if (options.Count == 0) return null;

        for (var idx = 0; idx < options.Count; idx++)
        {
            var hint = string.IsNullOrEmpty(options[idx].Hint) ? "" : $" — {options[idx].Hint}";
            Console.WriteLine($"  [{idx + 1}] {options[idx].Label}{hint}");
        }

        var initialIndex = options.FindIndex(
            o => WizardHelpers.AnyCodableEqual(o.Value, step.InitialValue));
        var defaultLabel = initialIndex >= 0 ? $" [{initialIndex + 1}]" : "";

        while (true)
        {
            var input   = ReadLine($"Select one{defaultLabel}");
            var trimmed = input?.Trim() ?? "";
            if (trimmed.Length == 0 && initialIndex >= 0)
                return BuildOptionValue(options[initialIndex]);
            if (trimmed.ToLowerInvariant() == "q")
                throw WizardCliException.Cancelled;
            if (int.TryParse(trimmed, out var n) && n >= 1 && n <= options.Count)
                return BuildOptionValue(options[n - 1]);
            Console.WriteLine("Invalid selection.");
        }
    }

    // Mirrors promptMultiSelect() in WizardCommand.swift.
    private static JsonNode PromptMultiSelect(WizardStep step)
    {
        var options = WizardHelpers.ParseWizardOptions(step.Options);
        if (options.Count == 0) return new JsonArray();

        for (var idx = 0; idx < options.Count; idx++)
        {
            var hint = string.IsNullOrEmpty(options[idx].Hint) ? "" : $" — {options[idx].Hint}";
            Console.WriteLine($"  [{idx + 1}] {options[idx].Label}{hint}");
        }

        var initialValues  = WizardHelpers.AnyCodableArray(step.InitialValue);
        var initialIndices = options
            .Select((o, i) => (o, i))
            .Where(t => initialValues.Any(iv => WizardHelpers.AnyCodableEqual(iv, t.o.Value)))
            .Select(t => t.i + 1)
            .ToList();
        var defaultLabel = initialIndices.Count == 0
            ? ""
            : $" [{string.Join(",", initialIndices)}]";

        while (true)
        {
            var input   = ReadLine($"Select (comma-separated){defaultLabel}");
            var trimmed = input?.Trim() ?? "";
            if (trimmed.Length == 0)
            {
                var arr = new JsonArray();
                foreach (var idx in initialIndices)
                    arr.Add(BuildOptionValue(options[idx - 1]));
                return arr;
            }
            if (trimmed.ToLowerInvariant() == "q")
                throw WizardCliException.Cancelled;

            var indices = trimmed.Split(',')
                .Select(p => int.TryParse(p.Trim(), out var n) ? n : -1)
                .Where(n => n >= 1 && n <= options.Count)
                .ToList();

            if (indices.Count == 0) { Console.WriteLine("Invalid selection."); continue; }

            var result = new JsonArray();
            foreach (var n in indices)
                result.Add(BuildOptionValue(options[n - 1]));
            return result;
        }
    }

    private static JsonNode? BuildOptionValue(WizardOption option)
        => option.Value ?? JsonValue.Create(option.Label);

    // Mirrors readLineWithPrompt() in WizardCommand.swift.
    private static string? ReadLine(string prompt)
    {
        Console.Write($"{prompt}: ");
        var line = Console.ReadLine();
        if (line == null) throw WizardCliException.Cancelled;
        return line;
    }
}

// Mirrors GatewayWizardClient actor in WizardCommand.swift — connects, sends challenge, runs RPCs.
internal sealed class GatewayWizardClient
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly Uri     _url;
    private readonly string? _token;
    private readonly string? _password;
    private readonly bool    _json;
    private readonly ClientWebSocket _ws = new();

    internal GatewayWizardClient(Uri url, string? token, string? password, bool json)
    {
        _url      = url;
        _token    = token;
        _password = password;
        _json     = json;
    }

    // Mirrors connect() + sendConnect() in GatewayWizardClient.
    internal async Task ConnectAsync(CancellationToken ct)
    {
        _ws.Options.SetRequestHeader("User-Agent", "openclaw-win/dev");
        await _ws.ConnectAsync(_url, ct);
        await SendConnectAsync(ct);
    }

    internal async Task CloseAsync()
    {
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
        }
        catch { /* best-effort */ }
        _ws.Dispose();
    }

    // Mirrors request() in GatewayWizardClient — sends RPC, loops until matching response.
    internal async Task<JsonNode?> RequestAsync(
        string method, JsonNode? @params, CancellationToken ct = default)
    {
        var id    = Guid.NewGuid().ToString();
        var frame = new RequestFrame("req", id, method, @params);
        var json  = JsonSerializer.Serialize(frame, JsonOpts);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);

        while (true)
        {
            var received = await ReceiveFrameAsync(ct);
            if (received is GatewayFrame.Res res && res.Frame.Id == id)
            {
                if (!res.Frame.Ok)
                {
                    var msg = res.Frame.Error?["message"]?.GetValue<string>() ?? "gateway error";
                    throw WizardCliException.GatewayError(msg);
                }
                return res.Frame.Payload;
            }
        }
    }

    // Mirrors decodePayload() in GatewayWizardClient.
    internal T DecodePayload<T>(JsonNode? payload)
    {
        if (payload == null) throw WizardCliException.DecodeError("missing payload");
        try   { return payload.Deserialize<T>(JsonOpts)!; }
        catch (Exception ex) { throw WizardCliException.DecodeError(ex.Message); }
    }

    // Mirrors sendConnect() in GatewayWizardClient — challenge nonce + connect RPC.
    private async Task SendConnectAsync(CancellationToken ct)
    {
        var osVersion  = Environment.OSVersion.Version;
        var platform   = $"windows {osVersion.Major}.{osVersion.Minor}.{osVersion.Build}";
        const string clientId   = "openclaw-windows";
        const string clientMode = "ui";
        const string role       = "operator";
        var scopes = GatewayScopes.DefaultOperatorConnectScopes;

        var clientObj = new JsonObject
        {
            ["id"]           = clientId,
            ["displayName"]  = Environment.MachineName ?? "OpenClaw Windows Wizard CLI",
            ["version"]      = "dev",
            ["platform"]     = platform,
            ["deviceFamily"] = "PC",
            ["mode"]         = clientMode,
            ["instanceId"]   = Guid.NewGuid().ToString(),
        };

        var @params = new JsonObject
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

        if (!string.IsNullOrEmpty(_token))
            @params["auth"] = new JsonObject { ["token"] = _token };
        else if (!string.IsNullOrEmpty(_password))
            @params["auth"] = new JsonObject { ["password"] = _password };

        // Wait for connect.challenge nonce (0.75 s) — mirrors waitForConnectChallenge().
        using var challengeCts = new CancellationTokenSource(TimeSpan.FromSeconds(0.75));
        using var linked       = CancellationTokenSource.CreateLinkedTokenSource(challengeCts.Token, ct);
        try
        {
            while (true)
            {
                var frame = await ReceiveFrameAsync(linked.Token);
                if (frame is GatewayFrame.Evt evt && evt.Frame.Event == "connect.challenge")
                {
                    // Nonce received — device signing omitted (CLI diagnostic context).
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (challengeCts.IsCancellationRequested)
        {
            // No challenge received within timeout — proceed without nonce.
        }

        var reqId = Guid.NewGuid().ToString();
        var connectFrame = new RequestFrame("req", reqId, "connect", @params);
        var json  = JsonSerializer.Serialize(connectFrame, JsonOpts);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct);

        while (true)
        {
            var frame = await ReceiveFrameAsync(ct);
            if (frame is GatewayFrame.Res res && res.Frame.Id == reqId)
            {
                if (!res.Frame.Ok)
                {
                    var msg = res.Frame.Error?["message"]?.GetValue<string>() ?? "gateway connect failed";
                    throw WizardCliException.GatewayError(msg);
                }
                return; // hello-ok received — connected
            }
        }
    }

    private async Task<GatewayFrame> ReceiveFrameAsync(CancellationToken ct)
    {
        var buffer      = new byte[65536];
        var accumulated = new List<ArraySegment<byte>>();

        while (true)
        {
            var result = await _ws.ReceiveAsync(buffer, ct);
            if (result.MessageType == WebSocketMessageType.Close) break;
            accumulated.Add(new ArraySegment<byte>(buffer[..result.Count]));
            if (result.EndOfMessage) break;
        }

        var text = Encoding.UTF8.GetString(accumulated.SelectMany(s => s).ToArray());
        return JsonSerializer.Deserialize<GatewayFrame>(text, JsonOpts)
               ?? new GatewayFrame.Unknown("null");
    }
}
