using OpenClawWindows.Domain.Instances;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory cache of presence entries polled from the gateway via system-presence RPC.
/// </summary>
public interface IInstancesStore
{
    IReadOnlyList<InstanceInfo> Instances { get; }
    string? LastError { get; }
    string? StatusMessage { get; }
    bool IsLoading { get; }

    // Raised on the calling thread when Instances or Status changes.
    event EventHandler? InstancesChanged;

    void Apply(IReadOnlyList<InstanceInfo> instances, string? statusMessage = null);
    void SetError(string error, string? statusMessage = null);
    void SetLoading(bool loading);
}
