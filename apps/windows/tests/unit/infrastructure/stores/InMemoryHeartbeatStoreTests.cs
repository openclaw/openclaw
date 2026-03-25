using System.Globalization;
using System.Text;
using System.Text.Json;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Health;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemoryHeartbeatStoreTests
{
    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void LastEvent_Initially_Null()
    {
        var store = new InMemoryHeartbeatStore();
        store.LastEvent.Should().BeNull();
    }

    // ── HandleHeartbeat ───────────────────────────────────────────────────────
    // Mirrors Swift: lastEvent = decoded from NotificationCenter data

    [Fact]
    public void HandleHeartbeat_ValidPayload_SetsLastEvent()
    {
        var store = new InMemoryHeartbeatStore();
        var payload = MakePayload("ok");

        store.HandleHeartbeat(payload);

        store.LastEvent.Should().NotBeNull();
        store.LastEvent!.Status.Should().Be("ok");
    }

    [Fact]
    public void HandleHeartbeat_AllFields_DeserializesCorrectly()
    {
        var store = new InMemoryHeartbeatStore();
        var payload = MakePayload("ok", ts: 1.5, to: "claude", preview: "hello",
            durationMs: 123.4, hasMedia: true, reason: "scheduled");

        store.HandleHeartbeat(payload);

        var evt = store.LastEvent!;
        evt.Ts.Should().Be(1.5);
        evt.Status.Should().Be("ok");
        evt.To.Should().Be("claude");
        evt.Preview.Should().Be("hello");
        evt.DurationMs.Should().Be(123.4);
        evt.HasMedia.Should().BeTrue();
        evt.Reason.Should().Be("scheduled");
    }

    [Fact]
    public void HandleHeartbeat_NullableFieldsMissing_DeserializesWithNulls()
    {
        var store = new InMemoryHeartbeatStore();
        var payload = MakePayload("idle");

        store.HandleHeartbeat(payload);

        var evt = store.LastEvent!;
        evt.To.Should().BeNull();
        evt.Preview.Should().BeNull();
        evt.DurationMs.Should().BeNull();
        evt.HasMedia.Should().BeNull();
        evt.Reason.Should().BeNull();
    }

    [Fact]
    public void HandleHeartbeat_OverwritesPreviousEvent()
    {
        var store = new InMemoryHeartbeatStore();
        store.HandleHeartbeat(MakePayload("ok"));
        store.HandleHeartbeat(MakePayload("idle"));

        store.LastEvent!.Status.Should().Be("idle");
    }

    [Fact]
    public void HandleHeartbeat_InvalidJson_IgnoresSilently()
    {
        var store = new InMemoryHeartbeatStore();
        var invalid = JsonDocument.Parse("\"not-an-object\"").RootElement;

        store.HandleHeartbeat(invalid);

        store.LastEvent.Should().BeNull();
    }

    // ── TryFetchInitialAsync ──────────────────────────────────────────────────
    // Mirrors Swift init Task: if lastEvent == nil, fetch last-heartbeat RPC

    [Fact]
    public async Task TryFetchInitialAsync_WhenEmpty_SetsEventFromRpc()
    {
        var store = new InMemoryHeartbeatStore();
        var rpc = Substitute.For<IGatewayRpcChannel>();
        var evt = new GatewayHeartbeatEvent(Ts: 100, Status: "ok", null, null, null, null, null);
        rpc.LastHeartbeatAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult<GatewayHeartbeatEvent?>(evt));

        await store.TryFetchInitialAsync(rpc);

        store.LastEvent.Should().Be(evt);
    }

    [Fact]
    public async Task TryFetchInitialAsync_WhenAlreadySet_SkipsRpc()
    {
        var store = new InMemoryHeartbeatStore();
        store.HandleHeartbeat(MakePayload("ok"));

        var rpc = Substitute.For<IGatewayRpcChannel>();

        await store.TryFetchInitialAsync(rpc);

        await rpc.DidNotReceive().LastHeartbeatAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task TryFetchInitialAsync_RpcReturnsNull_LeavesStoreEmpty()
    {
        var store = new InMemoryHeartbeatStore();
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.LastHeartbeatAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult<GatewayHeartbeatEvent?>(null));

        await store.TryFetchInitialAsync(rpc);

        store.LastEvent.Should().BeNull();
    }

    [Fact]
    public async Task TryFetchInitialAsync_RpcThrows_SwallowsException()
    {
        var store = new InMemoryHeartbeatStore();
        var rpc = Substitute.For<IGatewayRpcChannel>();
        rpc.LastHeartbeatAsync(Arg.Any<CancellationToken>()).Returns(Task.FromException<GatewayHeartbeatEvent?>(new Exception("gateway unreachable")));

        var act = () => store.TryFetchInitialAsync(rpc);
        await act.Should().NotThrowAsync();
        store.LastEvent.Should().BeNull();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static JsonElement MakePayload(
        string status,
        double ts = 1_700_000_000,
        string? to = null,
        string? preview = null,
        double? durationMs = null,
        bool? hasMedia = null,
        string? reason = null)
    {
        var parts = new StringBuilder();
        parts.Append(string.Create(CultureInfo.InvariantCulture, $"{{\"ts\":{ts},\"status\":\"{status}\""));
        if (to is not null)         parts.Append($",\"to\":\"{to}\"");
        if (preview is not null)    parts.Append($",\"preview\":\"{preview}\"");
        if (durationMs.HasValue)    parts.Append(string.Create(CultureInfo.InvariantCulture, $",\"durationMs\":{durationMs.Value}"));
        if (hasMedia.HasValue)      parts.Append($",\"hasMedia\":{hasMedia.Value.ToString().ToLower()}");
        if (reason is not null)     parts.Append($",\"reason\":\"{reason}\"");
        parts.Append('}');
        return JsonDocument.Parse(parts.ToString()).RootElement;
    }
}
