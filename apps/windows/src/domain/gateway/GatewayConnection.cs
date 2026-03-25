using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Gateway;

/// <summary>
/// Persistent WebSocket connection to the OpenClaw gateway.
/// Shared singleton per app session
/// </summary>
public sealed class GatewayConnection : Entity<string>
{
    // Gateway v2026.3.13 clears scopes for non-controlUi clients without device identity.
    // "openclaw-control-ui" preserves scopes when token auth succeeds (sharedAuthOk=true).
    private const string RequiredClientId = "openclaw-control-ui";

    public GatewayConnectionState State { get; private set; }
    public string? SessionKey { get; private set; }
    public string? CanvasHostUrl { get; private set; }
    public DateTimeOffset? ConnectedAt { get; private set; }

    private GatewayConnection(string clientId)
    {
        Guard.Against.NullOrWhiteSpace(clientId, nameof(clientId));
        Id = clientId;
        State = GatewayConnectionState.Disconnected;
    }

    public static GatewayConnection Create(string clientId)
    {
        if (clientId != RequiredClientId)
            throw new ArgumentException($"clientId must equal '{RequiredClientId}'");

        return new GatewayConnection(clientId);
    }

    public void MarkConnecting()
    {
        // Tolerate any state — reconnect coordinator may fire multiple attempts in parallel.
        State = GatewayConnectionState.Connecting;
        RaiseDomainEvent(new Events.GatewayConnecting());
    }

    public void MarkConnected(string sessionKey, string? canvasHostUrl, TimeProvider timeProvider)
    {
        Guard.Against.NullOrWhiteSpace(sessionKey, nameof(sessionKey));

        // Tolerate any state — reconnect races can leave the machine in Connecting,
        // Connected (duplicate hello-ok), or even Disconnected (rapid disconnect+reconnect).
        State = GatewayConnectionState.Connected;
        SessionKey = sessionKey;
        CanvasHostUrl = canvasHostUrl;
        ConnectedAt = timeProvider.GetUtcNow();  // MH-004: never DateTime.UtcNow

        RaiseDomainEvent(new Events.GatewayConnected { SessionKey = sessionKey });
    }

    public void MarkDisconnected(string reason)
    {
        State = GatewayConnectionState.Disconnected;
        SessionKey = null;
        ConnectedAt = null;

        RaiseDomainEvent(new Events.GatewayDisconnected { Reason = reason });
    }

    public void MarkPaused()
    {
        if (State != GatewayConnectionState.Connected)
            throw new InvalidOperationException($"Cannot pause from state {State}");

        State = GatewayConnectionState.Paused;
    }

    public void MarkReconnecting()
    {
        State = GatewayConnectionState.Reconnecting;
        SessionKey = null;

        RaiseDomainEvent(new Events.GatewayReconnecting());
    }
}
