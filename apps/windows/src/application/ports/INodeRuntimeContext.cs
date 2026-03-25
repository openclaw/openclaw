using OpenClawWindows.Application.ExecApprovals;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Port for node runtime state: main session key tracking and exec event emission.
/// </summary>
public interface INodeRuntimeContext
{
    string MainSessionKey { get; }

    void UpdateMainSessionKey(string sessionKey);

    void EmitExecEvent(string eventName, ExecEventPayload payload);
}
