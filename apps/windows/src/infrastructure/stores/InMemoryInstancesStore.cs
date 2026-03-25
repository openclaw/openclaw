using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Instances;

namespace OpenClawWindows.Infrastructure.Stores;

internal sealed class InMemoryInstancesStore : IInstancesStore
{
    private readonly Lock _lock = new();
    private List<InstanceInfo> _instances = [];
    private string? _lastError;
    private string? _statusMessage;
    private bool _isLoading;

    public IReadOnlyList<InstanceInfo> Instances
    {
        get { lock (_lock) { return _instances; } }
    }

    public string? LastError
    {
        get { lock (_lock) { return _lastError; } }
    }

    public string? StatusMessage
    {
        get { lock (_lock) { return _statusMessage; } }
    }

    public bool IsLoading
    {
        get { lock (_lock) { return _isLoading; } }
    }

    public event EventHandler? InstancesChanged;

    public void Apply(IReadOnlyList<InstanceInfo> instances, string? statusMessage = null)
    {
        lock (_lock)
        {
            _instances = new List<InstanceInfo>(instances);
            _lastError = null;
            _statusMessage = statusMessage;
            _isLoading = false;
        }
        InstancesChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetError(string error, string? statusMessage = null)
    {
        lock (_lock)
        {
            _lastError = error;
            _statusMessage = statusMessage;
            _isLoading = false;
        }
        InstancesChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetLoading(bool loading)
    {
        lock (_lock) { _isLoading = loading; }
        InstancesChanged?.Invoke(this, EventArgs.Empty);
    }
}
