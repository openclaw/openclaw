using OpenClawWindows.Domain.Nodes;

namespace OpenClawWindows.Application.Stores;

/// <summary>
/// In-memory cache of nodes polled from the gateway via node.list RPC.
/// </summary>
public interface INodesStore
{
    IReadOnlyList<NodeInfo> Nodes { get; }
    string? LastError { get; }
    string? StatusMessage { get; }
    bool IsLoading { get; }

    // Raised when Nodes or status changes.
    event EventHandler? NodesChanged;

    void Apply(IReadOnlyList<NodeInfo> nodes);
    void SetError(string error);
    void SetCancelled(string? statusMessage);
    void SetLoading(bool loading);
}
