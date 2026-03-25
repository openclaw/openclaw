using System.Text.Json;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory registry of active channel subscriptions and gateway channels.status snapshot.
/// </summary>
public interface IChannelStore
{
    IReadOnlyList<string> GetActive();
    void Register(string channelId);
    void Unregister(string channelId);

    JsonElement? StatusSnapshot { get; }
    DateTimeOffset? LastSuccess { get; }
    string? LastError { get; }
    void UpdateSnapshot(JsonElement snapshot, DateTimeOffset at);
    void SetError(string error);
}
