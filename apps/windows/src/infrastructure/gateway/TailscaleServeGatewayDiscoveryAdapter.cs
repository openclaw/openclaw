using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Infrastructure.Gateway;

// Discovers OpenClaw gateways advertised via Tailscale Serve on the local tailnet.
// Algorithm:
//   1. Run `tailscale.exe status --json` to enumerate online peers.
//   2. Probe each peer concurrently (max 6) via WSS; accept if gateway sends connect.challenge.
//   3. Yield results sorted by displayName.
internal sealed class TailscaleServeGatewayDiscoveryAdapter : IGatewayDiscovery
{
    // Tunables
    private const int MaxCandidates = 32;
    private const int ProbeConcurrency = 6;
    private static readonly TimeSpan DefaultProbeTimeout = TimeSpan.FromSeconds(1.6);
    private static readonly TimeSpan DiscoveryTimeout    = TimeSpan.FromSeconds(3.0);
    private static readonly TimeSpan StatusCliTimeout    = TimeSpan.FromSeconds(1.0);

    private readonly ILogger<TailscaleServeGatewayDiscoveryAdapter> _logger;

    public TailscaleServeGatewayDiscoveryAdapter(
        ILogger<TailscaleServeGatewayDiscoveryAdapter> logger)
    {
        _logger = logger;
    }

    public async IAsyncEnumerable<GatewayEndpoint> DiscoverAsync(
        [EnumeratorCancellation] CancellationToken ct)
    {
        var statusJson = await ReadTailscaleStatusAsync(ct);
        if (statusJson is null)
        {
            _logger.LogDebug("Tailscale CLI not available; skipping tailnet discovery");
            yield break;
        }

        var status = ParseStatus(statusJson);
        if (status is null)
        {
            _logger.LogWarning("Failed to parse tailscale status JSON");
            yield break;
        }

        var candidates = CollectCandidates(status);
        if (candidates.Count == 0) yield break;

        _logger.LogDebug(
            "Tailscale: probing {Count} online peer(s) for gateway challenge", candidates.Count);

        // Collect all results then sort
        var beacons = await ProbeAllAsync(candidates, ct);
        beacons.Sort((a, b) =>
            string.Compare(a.DisplayName, b.DisplayName, StringComparison.OrdinalIgnoreCase));

        foreach (var endpoint in beacons)
        {
            _logger.LogInformation(
                "Tailscale: discovered gateway {Name} at {Uri}", endpoint.DisplayName, endpoint.Uri);
            yield return endpoint;
        }
    }

    // Runs probes with bounded concurrency.
    private async Task<List<GatewayEndpoint>> ProbeAllAsync(
        List<Candidate> candidates, CancellationToken ct)
    {
        var deadline        = DateTimeOffset.UtcNow + DiscoveryTimeout;
        var scaled          = DiscoveryTimeout * 0.45;
        var clamped         = scaled < TimeSpan.FromSeconds(0.5) ? TimeSpan.FromSeconds(0.5) : scaled;
        var perProbeTimeout = clamped < DefaultProbeTimeout ? clamped : DefaultProbeTimeout;

        // SemaphoreSlim bounds concurrency to ProbeConcurrency slots.
        using var sem = new SemaphoreSlim(ProbeConcurrency, ProbeConcurrency);

        var tasks = candidates.Select(c => ProbeOneAsync(c, sem, deadline, perProbeTimeout, ct))
            .ToList();

        await Task.WhenAll(tasks);

        var byHost = new Dictionary<string, GatewayEndpoint>(StringComparer.OrdinalIgnoreCase);
        foreach (var task in tasks)
        {
            // task is already completed; no exception can surface here beyond what ProbeOneAsync handles
            var endpoint = task.IsCompletedSuccessfully ? task.Result : null;
            if (endpoint is null) continue;

            var key = endpoint.Uri.Host.ToLowerInvariant();
            byHost.TryAdd(key, endpoint);
        }

        return [.. byHost.Values];
    }

    private static async Task<GatewayEndpoint?> ProbeOneAsync(
        Candidate candidate,
        SemaphoreSlim sem,
        DateTimeOffset deadline,
        TimeSpan perProbeTimeout,
        CancellationToken ct)
    {
        // Acquire slot
        try
        {
            await sem.WaitAsync(ct);
        }
        catch (OperationCanceledException)
        {
            return null;
        }

        try
        {
            var remaining = deadline - DateTimeOffset.UtcNow;
            if (remaining <= TimeSpan.Zero) return null;

            var timeout   = remaining < perProbeTimeout ? remaining : perProbeTimeout;
            var reachable = await ProbeAsync(candidate.DnsName, timeout, ct);
            if (!reachable) return null;

            var result = GatewayEndpoint.FromTailscale(candidate.DnsName, candidate.DisplayName);
            return result.IsError ? null : result.Value;
        }
        finally
        {
            sem.Release();
        }
    }

    // Connects via WSS and returns true if the gateway sends a connect.challenge event.
    private static async Task<bool> ProbeAsync(string host, TimeSpan timeout, CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        try
        {
            await ws.ConnectAsync(new Uri($"wss://{host}"), timeoutCts.Token);

            var buf = new byte[4096];
            var result = await ws.ReceiveAsync(new Memory<byte>(buf), timeoutCts.Token);

            if (result.MessageType == WebSocketMessageType.Close) return false;

            var json = Encoding.UTF8.GetString(buf, 0, result.Count);
            return IsConnectChallenge(json);
        }
        catch
        {
            return false;
        }
        finally
        {
            if (ws.State == WebSocketState.Open)
            {
                try
                {
                    await ws.CloseAsync(
                        WebSocketCloseStatus.NormalClosure, null, CancellationToken.None);
                }
                catch { /* best-effort close */ }
            }
        }
    }

    private static bool IsConnectChallenge(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            return root.TryGetProperty("type", out var type) && type.GetString() == "event"
                && root.TryGetProperty("event", out var evt) && evt.GetString() == "connect.challenge";
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private async Task<string?> ReadTailscaleStatusAsync(CancellationToken ct)
    {
        var exePath = FindTailscaleExe();
        if (exePath is null) return null;

        return await RunAsync(exePath, ["status", "--json"], StatusCliTimeout, ct);
    }

    private static string? FindTailscaleExe()
    {
        // Check standard installation paths
        foreach (var folder in new[]
        {
            Environment.SpecialFolder.ProgramFiles,
            Environment.SpecialFolder.ProgramFilesX86,
        })
        {
            var path = Path.Combine(
                Environment.GetFolderPath(folder), "Tailscale", "tailscale.exe");
            if (File.Exists(path)) return path;
        }

        return null;
    }

    private static async Task<string?> RunAsync(
        string exe, string[] args, TimeSpan timeout, CancellationToken ct)
    {
        var psi = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
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
                // ReadToEndAsync must complete before WaitForExitAsync to avoid stdout buffer deadlock
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

    private List<Candidate> CollectCandidates(TailscaleStatus status)
    {
        var selfDns = NormalizeDns(status.SelfNode?.DnsName);
        var out_ = new List<Candidate>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var node in status.Peer.Values)
        {
            if (node.Online == false) continue;
            var dns = NormalizeDns(node.DnsName);
            if (dns is null || dns == selfDns) continue;
            if (!seen.Add(dns)) continue;

            out_.Add(new Candidate(
                dns,
                BuildDisplayName(node.HostName, dns)));

            if (out_.Count >= MaxCandidates) break;
        }

        return out_;
    }

    private static string? NormalizeDns(string? raw)
    {
        if (raw is null) return null;
        var trimmed = raw.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        // Strip trailing dot used by fully-qualified DNS names
        var withoutDot = trimmed.EndsWith('.') ? trimmed[..^1] : trimmed;
        var lower = withoutDot.ToLowerInvariant();
        return string.IsNullOrEmpty(lower) ? null : lower;
    }

    private static string BuildDisplayName(string? hostName, string dnsName)
    {
        if (!string.IsNullOrWhiteSpace(hostName))
            return hostName.Trim();

        // Use first DNS label as fallback display name.first)
        var firstLabel = dnsName.Split('.')[0];
        return string.IsNullOrEmpty(firstLabel) ? dnsName : firstLabel;
    }

    private sealed record Candidate(string DnsName, string DisplayName);

    // ── JSON model

    private sealed class TailscaleStatus
    {
        [System.Text.Json.Serialization.JsonPropertyName("Self")]
        public TailscaleNode? SelfNode { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("Peer")]
        public Dictionary<string, TailscaleNode> Peer { get; set; } = new();
    }

    private sealed class TailscaleNode
    {
        [System.Text.Json.Serialization.JsonPropertyName("DNSName")]
        public string? DnsName { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("HostName")]
        public string? HostName { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("Online")]
        public bool? Online { get; set; }
    }

    private static TailscaleStatus? ParseStatus(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<TailscaleStatus>(json);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
