using System.Text.Json;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;

namespace OpenClawWindows.Infrastructure.ExecApprovals;

// Caches the set of binary names declared by installed skills.
internal sealed class SkillBinsCache : ISkillBinsCache
{
    // Tunables
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(90);

    private readonly IGatewayRpcChannel _rpcChannel;
    private readonly ILogger<SkillBinsCache> _logger;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private IReadOnlySet<string> _bins = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private DateTimeOffset? _lastRefresh;

    public SkillBinsCache(IGatewayRpcChannel rpcChannel, ILogger<SkillBinsCache> logger)
    {
        _rpcChannel = rpcChannel;
        _logger = logger;
    }

    public async Task<IReadOnlySet<string>> CurrentBinsAsync(CancellationToken ct = default)
    {
        if (IsStale())
            await RefreshAsync(ct);
        return _bins;
    }

    private async Task RefreshAsync(CancellationToken ct)
    {
        await _lock.WaitAsync(ct);
        try
        {
            // Double-check after acquiring the lock.
            if (!IsStale()) return;

            var json = await _rpcChannel.SkillsStatusAsync(ct);
            var next = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            if (json.ValueKind == JsonValueKind.Object &&
                json.TryGetProperty("skills", out var skills) &&
                skills.ValueKind == JsonValueKind.Array)
            {
                foreach (var skill in skills.EnumerateArray())
                {
                    if (!skill.TryGetProperty("requirements", out var req)) continue;
                    if (!req.TryGetProperty("bins", out var bins)) continue;
                    if (bins.ValueKind != JsonValueKind.Array) continue;
                    foreach (var bin in bins.EnumerateArray())
                    {
                        var name = bin.GetString()?.Trim();
                        if (!string.IsNullOrEmpty(name))
                            next.Add(name);
                    }
                }
            }

            _bins = next;
            _lastRefresh = DateTimeOffset.UtcNow;
        }
        catch (Exception ex)
        {
            // On error, keep the previous bins unless this is the first attempt.
            _logger.LogDebug(ex, "SkillBinsCache refresh failed; using previous bins");
            if (_lastRefresh is null)
                _bins = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }
        finally
        {
            _lock.Release();
        }
    }

    private bool IsStale() =>
        _lastRefresh is null ||
        DateTimeOffset.UtcNow - _lastRefresh.Value > RefreshInterval;
}
