namespace OpenClawWindows.Tests.Unit.Domain.Gateway;

public sealed class GatewayConnectionTests
{
    // ── Create ─────────────────────────────────────────────────────────────

    [Fact]
    public void Create_WithCorrectClientId_Succeeds()
    {
        var conn = GatewayConnection.Create("openclaw-control-ui");

        conn.Should().NotBeNull();
        conn.Id.Should().Be("openclaw-control-ui");
        conn.State.Should().Be(GatewayConnectionState.Disconnected);
    }

    [Fact]
    public void Create_WithWrongClientId_Throws()
    {
        var act = () => GatewayConnection.Create("openclaw-macos");

        act.Should().Throw<ArgumentException>();
    }

    // ── MarkConnecting ──────────────────────────────────────────────────────

    [Fact]
    public void MarkConnecting_FromDisconnected_Transitions()
    {
        var conn = MakeConnection();

        conn.MarkConnecting();

        conn.State.Should().Be(GatewayConnectionState.Connecting);
    }

    [Fact]
    public void MarkConnecting_RaisesDomainEvent()
    {
        var conn = MakeConnection();

        conn.MarkConnecting();

        conn.DomainEvents.Should().ContainSingle(e => e is OpenClawWindows.Domain.Gateway.Events.GatewayConnecting);
    }

    [Fact]
    public void MarkConnecting_FromConnected_Tolerates()
    {
        var conn = ConnectedConnection();

        conn.MarkConnecting();

        conn.State.Should().Be(GatewayConnectionState.Connecting);
    }

    // ── MarkConnected ───────────────────────────────────────────────────────

    [Fact]
    public void MarkConnected_Transitions_AndStoresSessionKey()
    {
        var conn = MakeConnection();
        conn.MarkConnecting();

        conn.MarkConnected("sess-123", "http://canvas.host", TimeProvider.System);

        conn.State.Should().Be(GatewayConnectionState.Connected);
        conn.SessionKey.Should().Be("sess-123");
    }

    [Fact]
    public void MarkConnected_SetsConnectedAt()
    {
        var conn = MakeConnection();
        conn.MarkConnecting();

        conn.MarkConnected("sk", null, TimeProvider.System);

        conn.ConnectedAt.Should().NotBeNull();
    }

    [Fact]
    public void MarkConnected_FromDisconnected_Tolerates()
    {
        var conn = MakeConnection();

        conn.MarkConnected("sk", null, TimeProvider.System);

        conn.State.Should().Be(GatewayConnectionState.Connected);
        conn.SessionKey.Should().Be("sk");
    }

    // ── MarkDisconnected ────────────────────────────────────────────────────

    [Fact]
    public void MarkDisconnected_ClearsSessionKey()
    {
        var conn = ConnectedConnection();

        conn.MarkDisconnected("network error");

        conn.State.Should().Be(GatewayConnectionState.Disconnected);
        conn.SessionKey.Should().BeNull();
        conn.ConnectedAt.Should().BeNull();
    }

    [Fact]
    public void MarkDisconnected_RaisesDomainEvent()
    {
        var conn = ConnectedConnection();

        conn.MarkDisconnected("test");

        conn.DomainEvents.OfType<OpenClawWindows.Domain.Gateway.Events.GatewayDisconnected>()
            .Should().ContainSingle();
    }

    // ── MarkPaused ──────────────────────────────────────────────────────────

    [Fact]
    public void MarkPaused_FromConnected_Succeeds()
    {
        var conn = ConnectedConnection();

        conn.MarkPaused();

        conn.State.Should().Be(GatewayConnectionState.Paused);
    }

    [Fact]
    public void MarkPaused_FromDisconnected_Throws()
    {
        var conn = MakeConnection();

        var act = () => conn.MarkPaused();

        act.Should().Throw<InvalidOperationException>();
    }

    // ── MarkReconnecting ────────────────────────────────────────────────────

    [Fact]
    public void MarkReconnecting_ClearsSessionKey()
    {
        var conn = ConnectedConnection();

        conn.MarkReconnecting();

        conn.State.Should().Be(GatewayConnectionState.Reconnecting);
        conn.SessionKey.Should().BeNull();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private static GatewayConnection MakeConnection() =>
        GatewayConnection.Create("openclaw-control-ui");

    private static GatewayConnection ConnectedConnection()
    {
        var conn = MakeConnection();
        conn.MarkConnecting();
        conn.MarkConnected("sk", null, TimeProvider.System);
        conn.ClearDomainEvents();
        return conn;
    }
}
