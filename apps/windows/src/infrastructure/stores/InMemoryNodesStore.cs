using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Nodes;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryNodesStore : INodesStore
{
    private readonly Lock _lock = new();
    private List<NodeInfo> _nodes = [];
    private string? _lastError;
    private string? _statusMessage;
    private bool _isLoading;

    public IReadOnlyList<NodeInfo> Nodes         { get { lock (_lock) { return _nodes; } } }
    public string? LastError                     { get { lock (_lock) { return _lastError; } } }
    public string? StatusMessage                 { get { lock (_lock) { return _statusMessage; } } }
    public bool IsLoading                        { get { lock (_lock) { return _isLoading; } } }

    public event EventHandler? NodesChanged;

    public void Apply(IReadOnlyList<NodeInfo> nodes)
    {
        lock (_lock)
        {
            _nodes         = new List<NodeInfo>(nodes);
            _lastError     = null;
            _statusMessage = null;
            _isLoading     = false;
        }
        NodesChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetError(string error)
    {
        lock (_lock)
        {
            _nodes         = [];
            _lastError     = error;
            _statusMessage = null;
            _isLoading     = false;
        }
        NodesChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetCancelled(string? statusMessage)
    {
        lock (_lock)
        {
            _lastError     = null;
            _statusMessage = statusMessage;
            _isLoading     = false;
        }
        NodesChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetLoading(bool loading)
    {
        lock (_lock) { _isLoading = loading; }
        NodesChanged?.Invoke(this, EventArgs.Empty);
    }
}
