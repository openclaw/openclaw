using System.Text.Json;

namespace OpenClawWindows.Infrastructure.Gateway;

// Delivers device/node pairing push events to subscribing orchestrators.
// Implemented by GatewayRpcChannelAdapter alongside IGatewayMessageRouter so
// pairing orchestrators do not depend on the concrete adapter type.
internal interface IPairingEventSource
{
    event Action<JsonElement>? DevicePairRequested;
    event Action<JsonElement>? DevicePairResolved;
    event Action<JsonElement>? NodePairRequested;
    event Action<JsonElement>? NodePairResolved;
    // Gateway-level snapshot/seqGap push events — trigger reconcile in node orchestrator.
    event Action? GatewaySnapshot;
    event Action? GatewaySeqGap;
}
