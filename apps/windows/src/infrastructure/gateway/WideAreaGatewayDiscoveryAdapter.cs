using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Gateway;

/// <summary>
/// Wide-area gateway discovery via DNS-SD over Tailscale.
/// Activated by the OPENCLAW_WIDE_AREA_DOMAIN environment variable.
/// Uses nslookup.exe for DNS queries (Windows equivalent of /usr/bin/dig).
/// </summary>
internal sealed partial class WideAreaGatewayDiscoveryAdapter : IGatewayDiscovery
{
    // Tunables
    private const int    MaxCandidates             = 40;
    private const int    NameserverProbeConcurrency = 6;
    private static readonly TimeSpan DefaultProbeTimeout    = TimeSpan.FromSeconds(0.2);
    private static readonly TimeSpan TailscaleStatusTimeout = TimeSpan.FromSeconds(0.7);
    private static readonly TimeSpan DiscoveryTimeout       = TimeSpan.FromSeconds(2.0);

    // nslookup.exe is present on all supported Windows versions.
    private static readonly string NslookupExe =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "nslookup.exe");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly ILogger<WideAreaGatewayDiscoveryAdapter> _logger;

    public WideAreaGatewayDiscoveryAdapter(ILogger<WideAreaGatewayDiscoveryAdapter> logger)
    {
        _logger = logger;
    }

    public async IAsyncEnumerable<GatewayEndpoint> DiscoverAsync(
        [EnumeratorCancellation] CancellationToken ct)
    {
        var domain = ResolveWideAreaDomain();
        if (domain is null)
        {
            _logger.LogDebug("OPENCLAW_WIDE_AREA_DOMAIN not set; skipping wide-area discovery");
            yield break;
        }

        var started   = DateTimeOffset.UtcNow;
        TimeSpan Remaining() => DiscoveryTimeout - (DateTimeOffset.UtcNow - started);

        var statusJson = await ReadTailscaleStatusAsync(ct);
        if (statusJson is null)
        {
            _logger.LogDebug("Tailscale CLI unavailable; skipping wide-area discovery");
            yield break;
        }

        var ips = CollectTailnetIPv4s(statusJson);
        if (ips.Count == 0) yield break;

        var candidates    = ips.Take(MaxCandidates).ToList();
        var domainTrimmed = domain.TrimEnd('.');
        var serviceType   = $"_openclaw-gw._tcp.{domainTrimmed}";

        var nameserver = await FindNameserverAsync(candidates, serviceType, Remaining, ct);
        if (nameserver is null)
        {
            _logger.LogDebug("No wide-area DNS nameserver found in tailnet for {Domain}", domain);
            yield break;
        }

        // PTR: enumerate service instances registered under the service type.
        var rem       = Remaining();
        var ptrOutput = rem > TimeSpan.Zero
            ? await RunNslookupAsync(
                nameserver, serviceType, "ptr",
                rem < DefaultProbeTimeout ? rem : DefaultProbeTimeout, ct)
            : null;

        var ptrRecords = ParsePtrRecords(ptrOutput);
        if (ptrRecords.Count == 0) yield break;

        foreach (var rawPtr in ptrRecords)
        {
            if (Remaining() <= TimeSpan.Zero) break;
            if (string.IsNullOrWhiteSpace(rawPtr)) continue;

            // Strip trailing dot from FQDN.
            var ptrName      = rawPtr.EndsWith('.') ? rawPtr[..^1] : rawPtr;
            var suffix       = $"._openclaw-gw._tcp.{domainTrimmed}";
            var rawInst      = ptrName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
                ? ptrName[..^suffix.Length]
                : ptrName;
            var instanceName = DecodeDnsSdEscapes(rawInst);

            rem = Remaining();
            if (rem <= TimeSpan.Zero) break;

            var srvOutput = await RunNslookupAsync(
                nameserver, ptrName, "srv",
                rem < DefaultProbeTimeout ? rem : DefaultProbeTimeout, ct);
            var srv = ParseSrvRecord(srvOutput);
            if (srv is null) continue;
            var (host, port) = srv.Value;

            rem = Remaining();
            var txtOutput = rem > TimeSpan.Zero
                ? await RunNslookupAsync(
                    nameserver, ptrName, "txt",
                    rem < DefaultProbeTimeout ? rem : DefaultProbeTimeout, ct)
                : null;
            var txt = MapTxt(ParseTxtTokens(txtOutput ?? string.Empty));

            var displayName = txt.GetValueOrDefault("displayName") ?? instanceName;
            var tailnetDns  = txt.GetValueOrDefault("tailnetDns");

            // Prefer wss via tailnetDns (Tailscale Serve), fall back to direct ws host:port.
            var endpoint = tailnetDns is not null
                ? GatewayEndpoint.FromTailscale(tailnetDns, displayName)
                : GatewayEndpoint.Create($"ws://{host}:{port}", displayName);

            if (endpoint.IsError)
            {
                _logger.LogWarning(
                    "WideArea: skipping invalid beacon {Name} — {Err}",
                    displayName, endpoint.FirstError.Description);
                continue;
            }

            _logger.LogInformation(
                "WideArea: discovered gateway {Name} at {Uri}", displayName, endpoint.Value.Uri);
            yield return endpoint.Value;
        }
    }

    // ── Wide-area domain resolution ────────────────────────────────────────────

    // Reads OPENCLAW_WIDE_AREA_DOMAIN.
    private static string? ResolveWideAreaDomain()
    {
        var raw = Environment.GetEnvironmentVariable("OPENCLAW_WIDE_AREA_DOMAIN")?.Trim();
        if (string.IsNullOrEmpty(raw)) return null;
        var lower = raw.ToLowerInvariant();
        if (lower == "local" || lower == "local.") return null;
        return lower.EndsWith('.') ? lower : lower + ".";
    }

    // ── Tailscale status ───────────────────────────────────────────────────────

    private async Task<string?> ReadTailscaleStatusAsync(CancellationToken ct)
    {
        var exe = FindTailscaleExe();
        if (exe is null) return null;
        return await RunProcessAsync(exe, ["status", "--json"], TailscaleStatusTimeout, ct);
    }

    private static string? FindTailscaleExe()
    {
        foreach (var folder in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
        {
            var path = Path.Combine(Environment.GetFolderPath(folder), "Tailscale", "tailscale.exe");
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private static List<string> CollectTailnetIPv4s(string statusJson)
    {
        TailscaleStatus? status;
        try { status = JsonSerializer.Deserialize<TailscaleStatus>(statusJson, JsonOpts); }
        catch (JsonException) { return []; }
        if (status is null) return [];

        var ips  = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        void AddIps(IEnumerable<string>? src)
        {
            if (src is null) return;
            foreach (var ip in src)
                if (IsTailnetIPv4(ip) && seen.Add(ip)) ips.Add(ip);
        }

        AddIps(status.SelfNode?.TailscaleIPs);
        if (status.Peer is not null)
            foreach (var peer in status.Peer.Values)
                AddIps(peer.TailscaleIPs);

        return ips;
    }

    // ── Nameserver probing ─────────────────────────────────────────────────────

    // Probes candidates concurrently (max 6 workers) to find one that answers the PTR query.
    private async Task<string?> FindNameserverAsync(
        List<string> candidates,
        string probeName,
        Func<TimeSpan> remaining,
        CancellationToken ct)
    {
        using var foundCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        using var sem      = new SemaphoreSlim(NameserverProbeConcurrency, NameserverProbeConcurrency);
        var foundLock = new object();
        string? found = null;
        var timeLeft  = remaining();
        var deadline  = DateTimeOffset.UtcNow + (timeLeft > TimeSpan.Zero ? timeLeft : TimeSpan.Zero);

        var tasks = candidates.Select(ip => Task.Run(async () =>
        {
            try { await sem.WaitAsync(foundCts.Token); }
            catch (OperationCanceledException) { return; }

            try
            {
                var budget = deadline - DateTimeOffset.UtcNow;
                if (budget <= TimeSpan.Zero) return;

                var output = await RunNslookupAsync(
                    ip, probeName, "ptr",
                    budget < DefaultProbeTimeout ? budget : DefaultProbeTimeout,
                    foundCts.Token);

                if (ParsePtrRecords(output).Count > 0)
                {
                    lock (foundLock)
                    {
                        if (found is null)
                        {
                            found = ip;
                            foundCts.Cancel();
                        }
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception ex)
            {
                _logger.LogDebug("WideArea probe {Ip}: {Msg}", ip, ex.Message);
            }
            finally { sem.Release(); }
        }, CancellationToken.None)).ToList();

        await Task.WhenAll(tasks);
        return found;
    }

    // ── nslookup subprocess ────────────────────────────────────────────────────

    // Runs nslookup.exe and returns raw stdout.
    // nslookup argument order: -querytype=<type> -timeout=1 -retry=0 <name> <server>
    private static async Task<string?> RunNslookupAsync(
        string server, string name, string type, TimeSpan timeout, CancellationToken ct)
    {
        return await RunProcessAsync(
            NslookupExe,
            [$"-querytype={type}", "-timeout=1", "-retry=0", name, server],
            timeout,
            ct);
    }

    private static async Task<string?> RunProcessAsync(
        string exe, string[] args, TimeSpan timeout, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute        = false,
            RedirectStandardOutput = true,
            RedirectStandardError  = true,
            CreateNoWindow         = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        Process? proc = null;
        try
        {
            proc = new Process { StartInfo = psi };
            if (!proc.Start()) return null;
        }
        catch
        {
            proc?.Dispose();
            return null;
        }

        using (proc)
        using (var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            timeoutCts.CancelAfter(timeout);
            try
            {
                var stdout = await proc.StandardOutput.ReadToEndAsync(timeoutCts.Token);
                await proc.WaitForExitAsync(timeoutCts.Token);
                return string.IsNullOrWhiteSpace(stdout) ? null : stdout;
            }
            catch (OperationCanceledException)
            {
                if (!proc.HasExited) proc.Kill(entireProcessTree: true);
                return null;
            }
        }
    }

    // ── DNS record parsers ─────────────────────────────────────────────────────

    // Parses PTR records from nslookup output.
    // Matches lines like: "<name>   pointer = <fqdn>." (Windows nslookup format).
    private static List<string> ParsePtrRecords(string? output)
    {
        var list = new List<string>();
        if (string.IsNullOrWhiteSpace(output)) return list;

        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();
            // Windows nslookup PTR output: "   pointer = foo._openclaw-gw._tcp.domain."
            var match = PtrLineRegex().Match(line);
            if (match.Success)
            {
                var value = match.Groups[1].Value.Trim();
                if (!string.IsNullOrEmpty(value)) list.Add(value);
            }
        }
        return list;
    }

    // Parses SRV record from nslookup output.
    // Extracts port from "port = <n>" and host from "svr hostname = <host>".
    // Returns null if either field is missing.
    private static (string host, int port)? ParseSrvRecord(string? output)
    {
        if (string.IsNullOrWhiteSpace(output)) return null;

        int? port    = null;
        string? host = null;

        foreach (var raw in output.Split('\n'))
        {
            var line = raw.Trim();

            var portMatch = SrvPortRegex().Match(line);
            if (portMatch.Success && int.TryParse(portMatch.Groups[1].Value, out var p) && p > 0)
                port = p;

            var hostMatch = SrvHostRegex().Match(line);
            if (hostMatch.Success)
            {
                var h = hostMatch.Groups[1].Value.Trim();
                // Strip trailing dot from FQDN
                host = h.EndsWith('.') ? h[..^1] : h;
            }
        }

        if (port is null || string.IsNullOrEmpty(host)) return null;
        return (host, port.Value);
    }

    // Parses TXT tokens from nslookup output.
    // Extracts all "..." quoted strings.
    private static List<string> ParseTxtTokens(string output)
    {
        var tokens = new List<string>();
        foreach (Match match in TxtQuotedRegex().Matches(output))
            tokens.Add(UnescapeTxt(match.Groups[1].Value));
        return tokens;
    }

    // Maps "key=value" tokens to a dictionary.
    private static Dictionary<string, string> MapTxt(List<string> tokens)
    {
        var dict = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var token in tokens)
        {
            var idx = token.IndexOf('=');
            if (idx < 0) continue;
            var key      = token[..idx].Trim();
            var rawValue = token[(idx + 1)..].Trim();
            if (!string.IsNullOrEmpty(key))
                dict[key] = DecodeDnsSdEscapes(rawValue);
        }
        return dict;
    }

    // Unescapes \" and \\ inside TXT record strings.
    private static string UnescapeTxt(string value) =>
        value
            .Replace("\\\\", "\x00BSLASH\x00")   // protect \\
            .Replace("\\\"", "\"")
            .Replace("\\n",  "\n")
            .Replace("\x00BSLASH\x00", "\\");

    // Decodes DNS-SD \DDD (decimal byte) escape sequences.
    private static string DecodeDnsSdEscapes(string value)
    {
        if (!value.Contains('\\')) return value;

        var bytes   = new List<byte>();
        var pending = new StringBuilder();
        var chars   = value.AsSpan();
        var i       = 0;

        while (i < chars.Length)
        {
            if (chars[i] == '\\' && i + 3 < chars.Length)
            {
                var digits = chars.Slice(i + 1, 3);
                if (digits[0] is >= '0' and <= '9' &&
                    digits[1] is >= '0' and <= '9' &&
                    digits[2] is >= '0' and <= '9' &&
                    byte.TryParse(digits, out var b))
                {
                    // Flush pending text as UTF-8 bytes
                    if (pending.Length > 0)
                    {
                        bytes.AddRange(System.Text.Encoding.UTF8.GetBytes(pending.ToString()));
                        pending.Clear();
                    }
                    bytes.Add(b);
                    i += 4;
                    continue;
                }
            }
            pending.Append(chars[i]);
            i++;
        }

        if (pending.Length > 0)
            bytes.AddRange(System.Text.Encoding.UTF8.GetBytes(pending.ToString()));

        if (bytes.Count == 0) return value;
        return System.Text.Encoding.UTF8.GetString([.. bytes]);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    // Returns true for Tailscale CGNAT range 100.64.0.0/10.
    private static bool IsTailnetIPv4(string? value)
    {
        if (value is null) return false;
        var parts = value.Split('.');
        if (parts.Length != 4) return false;
        if (!int.TryParse(parts[0], out var a) || a != 100) return false;
        if (!int.TryParse(parts[1], out var b)) return false;
        return b >= 64 && b <= 127;
    }

    private static int? ParseInt(string? value)
    {
        if (value is null) return null;
        return int.TryParse(value.Trim(), out var n) ? n : null;
    }

    // ── Compiled regexes ───────────────────────────────────────────────────────

    // "   pointer = foo._openclaw-gw._tcp.domain."
    [GeneratedRegex(@"pointer\s*=\s*(.+)", RegexOptions.IgnoreCase)]
    private static partial Regex PtrLineRegex();

    // "          port           = 18789"
    [GeneratedRegex(@"port\s*=\s*(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex SrvPortRegex();

    // "          svr hostname   = host.domain."
    [GeneratedRegex(@"svr\s+hostname\s*=\s*(.+)", RegexOptions.IgnoreCase)]
    private static partial Regex SrvHostRegex();

    // "\"displayName=foo\""
    [GeneratedRegex("\"([^\"]*)\"")]
    private static partial Regex TxtQuotedRegex();

    // ── JSON model

    private sealed class TailscaleStatus
    {
        [JsonPropertyName("Self")]
        public TailscaleNode? SelfNode { get; set; }

        [JsonPropertyName("Peer")]
        public Dictionary<string, TailscaleNode>? Peer { get; set; }
    }

    private sealed class TailscaleNode
    {
        [JsonPropertyName("TailscaleIPs")]
        public List<string>? TailscaleIPs { get; set; }
    }
}
