using System.Text.Json;
using System.Text.Json.Serialization;
using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.NodeMode;

/// <summary>
/// Unified node runtime state: main session key tracking and exec event emission.
/// Actor isolation maps to a volatile string field + best-effort event delivery via INodeEventSink.
/// Not an IHostedService; lifecycle is owned by WindowsNodeModeCoordinator.
/// </summary>
internal sealed class WindowsNodeRuntime : INodeRuntimeContext
{
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    // Lazy to break the circular DI dependency:
    // WindowsNodeModeCoordinator → INodeRuntimeContext → WindowsNodeRuntime → INodeEventSink → WindowsNodeModeCoordinator
    // Lazy captures the factory without resolving it during construction, so the cycle never triggers.
    private readonly Lazy<INodeEventSink> _eventSink;

    // Volatile: UpdateMainSessionKey may be called from the node WS task;
    // MainSessionKey is read from MediatR handler dispatch tasks concurrently.
    private volatile string _mainSessionKey = "main";

    public WindowsNodeRuntime(Lazy<INodeEventSink> eventSink)
    {
        _eventSink = eventSink;
    }

    public string MainSessionKey => _mainSessionKey;

    // Guard: empty/whitespace-only trimmed values are silently ignored.
    public void UpdateMainSessionKey(string sessionKey)
    {
        var trimmed = sessionKey.Trim();
        if (!string.IsNullOrEmpty(trimmed))
            _mainSessionKey = trimmed;
    }

    // Best-effort: swallows serialization errors
    public void EmitExecEvent(string eventName, ExecEventPayload payload)
    {
        try
        {
            var json = JsonSerializer.Serialize(payload, JsonOpts);
            _eventSink.Value.TrySendEvent(eventName, json);
        }
        catch { }
    }
}
