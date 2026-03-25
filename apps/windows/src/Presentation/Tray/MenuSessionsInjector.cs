using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Domain.Sessions;
using OpenClawWindows.Domain.Usage;

namespace OpenClawWindows.Presentation.Tray;

/// <summary>
/// Manages three timed caches for the tray context menu: sessions, usage summary, and cost summary.
/// the ViewModel data-binds to the exposed properties.
/// </summary>
internal sealed class MenuSessionsInjector
{
    // Tunables
    internal const double FallbackWidth        = 320;           // fallbackWidth
    internal static readonly TimeSpan ActiveWindow         = TimeSpan.FromDays(1);
    private  static readonly TimeSpan RefreshInterval      = TimeSpan.FromSeconds(12);
    private  static readonly TimeSpan UsageRefreshInterval = TimeSpan.FromSeconds(30);
    private  static readonly TimeSpan CostRefreshInterval  = TimeSpan.FromSeconds(45);
    private  const int    UsageTimeoutMs       = 5_000;         // UsageLoader timeoutMs
    private  const int    CostTimeoutMs        = 7_000;         // CostUsageLoader timeoutMs

    private readonly ISender            _sender;
    private readonly IGatewayRpcChannel _rpc;
    // serializes all cache mutations under lock.
    private readonly SemaphoreSlim      _lock = new(1, 1);

    // Session cache
    private List<SessionRow> _cachedRows        = [];
    private string?          _cacheErrorText;
    private DateTimeOffset?  _cacheUpdatedAt;
    private string?          _cachedDefaultModel;

    // Usage cache
    private GatewayUsageSummary? _cachedUsageSummary;
    private DateTimeOffset?      _usageCacheUpdatedAt;

    // Cost cache
    private GatewayCostUsageSummary? _cachedCostSummary;
    private string?                  _cachedCostErrorText;
    private DateTimeOffset?          _costCacheUpdatedAt;

    private CancellationTokenSource? _loadCts;
    private bool _warmStarted;

    public MenuSessionsInjector(ISender sender, IGatewayRpcChannel rpc)
    {
        _sender = sender;
        _rpc    = rpc;
    }

    // ── Exposed cache state ───────────────────────────────────────────────────

    internal IReadOnlyList<SessionRow>     CachedRows          => _cachedRows;
    internal string?                       CacheErrorText      => _cacheErrorText;
    internal string?                       CachedDefaultModel  => _cachedDefaultModel;
    internal GatewayUsageSummary?          CachedUsageSummary  => _cachedUsageSummary;
    internal GatewayCostUsageSummary?      CachedCostSummary   => _cachedCostSummary;
    internal string?                       CachedCostErrorText => _cachedCostErrorText;

    // ── Lifecycle ────────────────────────────────────────────────────────────

    // starts background cache preload once.
    internal void WarmUp()
    {
        if (_warmStarted) return;
        _warmStarted = true;
        _ = RefreshAllAsync(isConnected: false, force: true, CancellationToken.None);
    }

    // awaits if cache is empty, else backgrounds.
    internal async Task OnMenuOpenedAsync(bool isConnected, CancellationToken ct = default)
    {
        _loadCts?.Cancel();
        _loadCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var cts = _loadCts;

        var force = _cachedRows.Count == 0 || _cacheErrorText != null;
        if (force)
            await RefreshAllAsync(isConnected, force: true, cts.Token);
        else
            _ = RefreshAllAsync(isConnected, force: false, cts.Token);
    }

    // cancels any in-flight load.
    internal void OnMenuClosed()
    {
        _loadCts?.Cancel();
        _loadCts = null;
    }

    // ── Refresh ───────────────────────────────────────────────────────────────

    private async Task RefreshAllAsync(bool isConnected, bool force, CancellationToken ct)
    {
        await RefreshSessionCacheAsync(isConnected, force, ct);
        await RefreshUsageCacheAsync(isConnected, force, ct);
        await RefreshCostCacheAsync(isConnected, force, ct);
    }

    private async Task RefreshSessionCacheAsync(bool isConnected, bool force, CancellationToken ct)
    {
        if (!force && _cacheUpdatedAt.HasValue &&
            (DateTimeOffset.UtcNow - _cacheUpdatedAt.Value) < RefreshInterval)
        {
            return;
        }

        if (!isConnected)
        {
            _cacheErrorText = _cachedRows.Count > 0
                ? "Gateway disconnected (showing cached)"
                : null;
            _cacheUpdatedAt = DateTimeOffset.UtcNow;
            return;
        }

        await _lock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Re-check under lock to avoid a race between two concurrent callers.
            if (!force && _cacheUpdatedAt.HasValue &&
                (DateTimeOffset.UtcNow - _cacheUpdatedAt.Value) < RefreshInterval)
            {
                return;
            }

            var (rows, defaultModel) = await LoadSessionRowsAsync(ct);
            _cachedRows         = rows;
            _cachedDefaultModel = defaultModel;
            _cacheErrorText     = null;
            _cacheUpdatedAt     = DateTimeOffset.UtcNow;
        }
        catch (OperationCanceledException) { /* ct cancelled — leave stale cache */ }
        catch
        {
            _cachedRows     = [];
            _cacheErrorText = "Sessions unavailable";
            _cacheUpdatedAt = DateTimeOffset.UtcNow;
        }
        finally
        {
            _lock.Release();
        }
    }

    private async Task RefreshUsageCacheAsync(bool isConnected, bool force, CancellationToken ct)
    {
        if (!force && _usageCacheUpdatedAt.HasValue &&
            (DateTimeOffset.UtcNow - _usageCacheUpdatedAt.Value) < UsageRefreshInterval)
        {
            return;
        }

        if (!isConnected)
        {
            _usageCacheUpdatedAt = DateTimeOffset.UtcNow;
            return;
        }

        try
        {
            _cachedUsageSummary = await _rpc.RequestDecodedAsync<GatewayUsageSummary>(
                "usage.status", timeoutMs: UsageTimeoutMs, ct: ct);
        }
        catch (OperationCanceledException) { /* leave stale */ }
        catch { _cachedUsageSummary = null; }

        _usageCacheUpdatedAt = DateTimeOffset.UtcNow;
    }

    private async Task RefreshCostCacheAsync(bool isConnected, bool force, CancellationToken ct)
    {
        if (!force && _costCacheUpdatedAt.HasValue &&
            (DateTimeOffset.UtcNow - _costCacheUpdatedAt.Value) < CostRefreshInterval)
        {
            return;
        }

        if (!isConnected)
        {
            _costCacheUpdatedAt = DateTimeOffset.UtcNow;
            return;
        }

        try
        {
            _cachedCostSummary   = await _rpc.RequestDecodedAsync<GatewayCostUsageSummary>(
                "usage.cost", timeoutMs: CostTimeoutMs, ct: ct);
            _cachedCostErrorText = null;
        }
        catch (OperationCanceledException) { /* leave stale */ }
        catch (Exception ex)
        {
            _cachedCostSummary   = null;
            _cachedCostErrorText = CompactUsageError(ex.Message);
        }

        _costCacheUpdatedAt = DateTimeOffset.UtcNow;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // Also returns defaults.model
    private async Task<(List<SessionRow> Rows, string? DefaultModel)> LoadSessionRowsAsync(CancellationToken ct)
    {
        var result = await _sender.Send(new ListSessionsQuery(Limit: 32), ct);
        if (result.IsError)
            throw new InvalidOperationException(result.FirstError.Description);

        var now      = DateTimeOffset.UtcNow;
        var filtered = result.Value.Rows.Where(row =>
        {
            if (row.Key == "main") return true;
            if (!row.UpdatedAt.HasValue) return false;
            return (now - row.UpdatedAt.Value) <= ActiveWindow;
        }).ToList();

        filtered.Sort((lhs, rhs) =>
        {
            if (lhs.Key == "main") return -1;
            if (rhs.Key == "main") return  1;
            var l = lhs.UpdatedAt ?? DateTimeOffset.MinValue;
            var r = rhs.UpdatedAt ?? DateTimeOffset.MinValue;
            return r.CompareTo(l);
        });

        return (filtered, result.Value.Defaults.Model);
    }

    // 90-char truncation with "Usage unavailable" fallback.
    private static string CompactUsageError(string message)
    {
        var trimmed = message.Trim();
        if (trimmed.Length == 0) return "Usage unavailable";
        if (trimmed.Length > 90) return $"{trimmed[..87]}…";
        return trimmed;
    }
}
