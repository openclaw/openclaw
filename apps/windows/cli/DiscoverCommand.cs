// Mirrors DiscoverCommand.swift: mDNS gateway discovery using Zeroconf (NuGet).
// Service type matches BonjourTypes.swift: _openclaw-gw._tcp.local.
using System.Text.Json;
using System.Text.Json.Serialization;
using Zeroconf;

namespace OpenClawWindows.CLI;

internal sealed class DiscoveryOptions
{
    internal int  TimeoutMs    { get; private set; } = 2000;
    internal bool Json         { get; private set; }
    internal bool IncludeLocal { get; private set; }
    internal bool Help         { get; private set; }

    // Mirrors DiscoveryOptions.parse() in DiscoverCommand.swift.
    internal static DiscoveryOptions Parse(string[] args)
    {
        var opts = new DiscoveryOptions();
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
                case "--include-local":
                    opts.IncludeLocal = true;
                    break;
                case "--timeout" when i + 1 < args.Length:
                    if (int.TryParse(args[++i].Trim(), out var ms))
                        opts.TimeoutMs = Math.Max(100, ms);
                    break;
                default:
                    break;
            }
            i++;
        }
        return opts;
    }
}

// Mirrors DiscoveryOutput + DiscoveryOutput.Gateway in DiscoverCommand.swift.
internal sealed class DiscoveryOutput
{
    [JsonPropertyName("status")]       public required string          Status       { get; init; }
    [JsonPropertyName("timeoutMs")]    public required int             TimeoutMs    { get; init; }
    [JsonPropertyName("includeLocal")] public required bool            IncludeLocal { get; init; }
    [JsonPropertyName("count")]        public required int             Count        { get; init; }
    [JsonPropertyName("gateways")]     public required List<Gateway>  Gateways     { get; init; }

    internal sealed class Gateway
    {
        [JsonPropertyName("displayName")]  public required string  DisplayName  { get; init; }
        [JsonPropertyName("lanHost")]      public          string? LanHost      { get; init; }
        [JsonPropertyName("tailnetDns")]   public          string? TailnetDns   { get; init; }
        [JsonPropertyName("sshPort")]      public required int     SshPort      { get; init; }
        [JsonPropertyName("gatewayPort")]  public          int?    GatewayPort  { get; init; }
        [JsonPropertyName("cliPath")]      public          string? CliPath      { get; init; }
        [JsonPropertyName("stableID")]     public required string  StableID     { get; init; }
        [JsonPropertyName("debugID")]      public required string  DebugID      { get; init; }
        [JsonPropertyName("isLocal")]      public required bool    IsLocal      { get; init; }
    }
}

internal static class DiscoverCommand
{
    private const string ServiceType = "_openclaw-gw._tcp.local.";

    internal static async Task RunAsync(string[] args)
    {
        var opts = DiscoveryOptions.Parse(args);
        if (opts.Help)
        {
            Console.WriteLine("""
                openclaw-win discover

                Usage:
                  openclaw-win discover [--timeout <ms>] [--json] [--include-local]

                Options:
                  --timeout <ms>     Discovery window in milliseconds (default: 2000)
                  --json             Emit JSON
                  --include-local    Include gateways considered local
                  -h, --help         Show help
                """);
            return;
        }

        var gateways = new List<DiscoveryOutput.Gateway>();
        string status;

        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(opts.TimeoutMs));
            var hosts = await ZeroconfResolver.ResolveAsync(
                ServiceType,
                scanTime: TimeSpan.FromMilliseconds(opts.TimeoutMs),
                cancellationToken: cts.Token);

            foreach (var host in hosts)
            {
                var txt = ExtractTxtRecords(host);
                var isLocal = NetworkHelpers.IsLocalIp(host.IPAddress);

                // Skip local gateways unless --include-local is set
                if (isLocal && !opts.IncludeLocal) continue;

                gateways.Add(new DiscoveryOutput.Gateway
                {
                    DisplayName = host.DisplayName,
                    LanHost     = host.IPAddress,
                    TailnetDns  = txt.GetValueOrDefault("tailnetDns"),
                    SshPort     = TryParseInt(txt.GetValueOrDefault("sshPort")) ?? 22,
                    GatewayPort = TryParseInt(txt.GetValueOrDefault("gatewayPort"))
                                  ?? ExtractServicePort(host),
                    CliPath     = txt.GetValueOrDefault("cliPath"),
                    StableID    = txt.GetValueOrDefault("stableId") ?? host.IPAddress,
                    DebugID     = txt.GetValueOrDefault("debugId")  ?? host.DisplayName,
                    IsLocal     = isLocal,
                });
            }
            status = "ok";
        }
        catch (OperationCanceledException)
        {
            status = "timeout";
        }
        catch (Exception ex)
        {
            status = $"error: {ex.Message}";
        }

        if (opts.Json)
        {
            var payload = new DiscoveryOutput
            {
                Status       = status,
                TimeoutMs    = opts.TimeoutMs,
                IncludeLocal = opts.IncludeLocal,
                Count        = gateways.Count,
                Gateways     = gateways,
            };
            var jsonOpts = new JsonSerializerOptions
            {
                WriteIndented = true,
                PropertyNamingPolicy = null,
            };
            Console.WriteLine(JsonSerializer.Serialize(payload, jsonOpts));
            return;
        }

        Console.WriteLine("Gateway Discovery (Windows Zeroconf)");
        Console.WriteLine($"Status: {status}");
        Console.WriteLine(
            $"Found {gateways.Count} gateway(s){(opts.IncludeLocal ? "" : " (local filtered)")}");

        foreach (var gw in gateways)
        {
            var hosts = new[] { gw.TailnetDns, gw.LanHost }
                .Where(h => !string.IsNullOrWhiteSpace(h))
                .Select(h => h!)
                .ToList();

            Console.WriteLine($"- {gw.DisplayName}");
            Console.WriteLine($"  hosts: {(hosts.Count == 0 ? "(none)" : string.Join(", ", hosts))}");
            Console.WriteLine($"  ssh: {gw.SshPort}");
            if (gw.GatewayPort.HasValue)
                Console.WriteLine($"  gatewayPort: {gw.GatewayPort}");
            if (gw.CliPath != null)
                Console.WriteLine($"  cliPath: {gw.CliPath}");
            Console.WriteLine($"  isLocal: {gw.IsLocal}");
            Console.WriteLine($"  stableID: {gw.StableID}");
            Console.WriteLine($"  debugID: {gw.DebugID}");
        }
    }

    // Extract flattened TXT record dict from first TXT record set of the matching service.
    private static Dictionary<string, string> ExtractTxtRecords(IZeroconfHost host)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!host.Services.TryGetValue(ServiceType, out var svc)) return result;

        foreach (var recordSet in svc.Properties)
        {
            foreach (var kv in recordSet)
            {
                if (!result.ContainsKey(kv.Key))
                    result[kv.Key] = kv.Value;
            }
        }
        return result;
    }

    private static int? ExtractServicePort(IZeroconfHost host)
    {
        if (!host.Services.TryGetValue(ServiceType, out var svc)) return null;
        return svc.Port > 0 ? svc.Port : null;
    }

    private static int? TryParseInt(string? s)
        => int.TryParse(s, out var n) ? n : null;
}
