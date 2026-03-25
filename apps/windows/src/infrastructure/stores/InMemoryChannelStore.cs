using System.Text.Json;
using OpenClawWindows.Application.Stores;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryChannelStore : IChannelStore
{
    private readonly HashSet<string> _channels = new(StringComparer.Ordinal);
    private readonly object _lock = new();

    private JsonElement? _statusSnapshot;
    private DateTimeOffset? _lastSuccess;
    private string? _lastError;

    public JsonElement? StatusSnapshot { get { lock (_lock) return _statusSnapshot; } }
    public DateTimeOffset? LastSuccess  { get { lock (_lock) return _lastSuccess; } }
    public string? LastError            { get { lock (_lock) return _lastError; } }

    public IReadOnlyList<string> GetActive()
    {
        lock (_lock) return [.. _channels];
    }

    public void Register(string channelId)
    {
        lock (_lock) _channels.Add(channelId);
    }

    public void Unregister(string channelId)
    {
        lock (_lock) _channels.Remove(channelId);
    }

    public void UpdateSnapshot(JsonElement snapshot, DateTimeOffset at)
    {
        lock (_lock)
        {
            // Clone so the element outlives the JsonDocument that created it.
            _statusSnapshot = snapshot.Clone();
            _lastSuccess = at;
            _lastError = null;
        }
    }

    public void SetError(string error)
    {
        lock (_lock) _lastError = error;
    }
}
