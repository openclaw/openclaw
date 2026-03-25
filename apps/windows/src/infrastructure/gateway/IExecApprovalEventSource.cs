using System.Text.Json;

namespace OpenClawWindows.Infrastructure.Gateway;

// Delivers exec approval push events to subscribing orchestrators.
// Implemented by GatewayRpcChannelAdapter alongside IGatewayMessageRouter.
internal interface IExecApprovalEventSource
{
    event Action<JsonElement>? ExecApprovalRequested;
}
