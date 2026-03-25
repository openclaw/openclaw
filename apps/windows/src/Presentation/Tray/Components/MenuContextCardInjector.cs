using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Domain.Sessions;

namespace OpenClawWindows.Presentation.Tray.Components;

/// <summary>
/// Manages session-card state for the tray menu with cache and refresh throttle.
/// a service that the ViewModel queries; WinUI3 binds directly to CachedRows/CacheErrorText.
/// </summary>
internal sealed class MenuContextCardInjector
{
    // Tunables
    internal const double FallbackCardWidth      = 320;           // fallbackCardWidth
    internal static readonly TimeSpan ActiveWindow      = TimeSpan.FromDays(1);
    internal static readonly TimeSpan RefreshInterval  = TimeSpan.FromSeconds(15);

    private readonly ISender _sender;
    // SemaphoreSlim(1,1) serializes all cache mutations.
    private readonly SemaphoreSlim _lock = new(1, 1);

    private List<SessionRow> _cachedRows = [];
    private string? _cacheErrorText;
    private DateTimeOffset? _cacheUpdatedAt;
    private CancellationTokenSource? _loadCts;
    private bool _warmStarted;

    public MenuContextCardInjector(ISender sender) => _sender = sender;

    // snapshot for the current render cycle.
    internal IReadOnlyList<SessionRow> CachedRows => _cachedRows;

    internal string? CacheErrorText => _cacheErrorText;

    // begins background cache preload once.
    internal void WarmUp()
    {
        if (_warmStarted) return;
        _warmStarted = true;
        _ = RefreshCacheAsync(force: true, CancellationToken.None);
    }

    // refreshes if empty, else backgrounds for next open.
    internal async Task OnMenuOpenedAsync(CancellationToken ct = default)
    {
        _loadCts?.Cancel();
        _loadCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var cts = _loadCts;

        var initialIsLoading = _cachedRows.Count == 0;
        if (initialIsLoading)
        {
            // Block the caller (tray PrepareAsync) until data is available.
            await RefreshCacheAsync(force: true, cts.Token);
        }
        else
        {
            _ = RefreshCacheAsync(force: false, cts.Token);
        }
    }

    // cancels any in-flight load.
    internal void OnMenuClosed()
    {
        _loadCts?.Cancel();
        _loadCts = null;
    }

    // skips if cache is fresh and !force.
    private async Task RefreshCacheAsync(bool force, CancellationToken ct)
    {
        if (!force && _cacheUpdatedAt.HasValue &&
            (DateTimeOffset.UtcNow - _cacheUpdatedAt.Value) < RefreshInterval)
        {
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

            var rows = await LoadCurrentRowsAsync(ct);
            _cachedRows     = rows;
            _cacheErrorText = null;
            _cacheUpdatedAt = DateTimeOffset.UtcNow;
        }
        catch (OperationCanceledException) { /* ct cancelled — leave stale cache */ }
        catch (Exception ex)
        {
            if (_cachedRows.Count == 0)
            {
                var raw = ex.Message.Trim();
                if (raw.Length == 0)
                {
                    _cacheErrorText = "Could not load sessions";
                }
                else
                {
                    var firstLine = raw.Split('\n')[0].Trim();
                    _cacheErrorText = firstLine.Length > 90 ? $"{firstLine[..87]}…" : firstLine;
                }
            }

            _cacheUpdatedAt = DateTimeOffset.UtcNow;
        }
        finally
        {
            _lock.Release();
        }
    }

    // query gateway, apply activeWindowSeconds filter and sort.
    private async Task<List<SessionRow>> LoadCurrentRowsAsync(CancellationToken ct)
    {
        var result = await _sender.Send(new ListSessionsQuery(), ct);
        if (result.IsError)
            throw new InvalidOperationException(result.FirstError.Description);

        var now    = DateTimeOffset.UtcNow;
        var loaded = result.Value.Rows;

        var current = loaded.Where(row =>
        {
            if (row.Key == "main") return true;
            if (!row.UpdatedAt.HasValue) return false;
            return (now - row.UpdatedAt.Value) <= ActiveWindow;
        }).ToList();

        current.Sort((lhs, rhs) =>
        {
            if (lhs.Key == "main") return -1;
            if (rhs.Key == "main") return  1;
            var l = lhs.UpdatedAt ?? DateTimeOffset.MinValue;
            var r = rhs.UpdatedAt ?? DateTimeOffset.MinValue;
            return r.CompareTo(l); // descending
        });

        return current;
    }
}
