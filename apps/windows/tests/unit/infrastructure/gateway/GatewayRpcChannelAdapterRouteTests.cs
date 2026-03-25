using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

public sealed class GatewayRpcChannelAdapterRouteTests
{
    private readonly IGatewayWebSocket _ws = Substitute.For<IGatewayWebSocket>();
    private readonly GatewayConnection _connection = GatewayConnection.Create("openclaw-control-ui");
    private readonly InMemoryWorkActivityStore _workActivity = new();
    private readonly InMemoryAgentEventStore _agentEvents = new();
    private readonly InMemoryCronJobsStore _cronJobs = new();
    private readonly InMemoryHeartbeatStore _heartbeatStore = new();
    private readonly GatewayRpcChannelAdapter _adapter;

    public GatewayRpcChannelAdapterRouteTests()
    {
        _adapter = new GatewayRpcChannelAdapter(
            _ws, _connection, _workActivity, _agentEvents, _cronJobs, _heartbeatStore,
            NullLogger<GatewayRpcChannelAdapter>.Instance);
        // Pre-open the handshake gate so RPC tests don't block waiting for hello-ok.
        _adapter.NotifyHandshakeComplete();
    }

    // ── RouteEvent: gateway-level state events ────────────────────────────────

    [Fact]
    public void RouteEvent_Snapshot_FiresGatewaySnapshot()
    {
        var fired = 0;
        _adapter.GatewaySnapshot += () => fired++;

        _adapter.RouteEvent("snapshot", null);

        fired.Should().Be(1);
    }

    [Fact]
    public void RouteEvent_Snapshot_NullPayload_FiresHealthReceivedTrue()
    {
        bool? received = null;
        _adapter.HealthReceived += ok => received = ok;

        _adapter.RouteEvent("snapshot", null);

        // Default to true when payload is absent — mirrors ?? true in WebChatSwiftUI.swift:158
        received.Should().BeTrue();
    }

    [Fact]
    public void RouteEvent_Snapshot_WithHealthOkFalse_FiresHealthReceivedFalse()
    {
        bool? received = null;
        _adapter.HealthReceived += ok => received = ok;

        using var doc = JsonDocument.Parse("""{"snapshot":{"health":{"ok":false}}}""");
        _adapter.RouteEvent("snapshot", doc.RootElement.Clone());

        received.Should().BeFalse();
    }

    [Fact]
    public void RouteEvent_Snapshot_WithHealthOkTrue_FiresHealthReceivedTrue()
    {
        bool? received = null;
        _adapter.HealthReceived += ok => received = ok;

        using var doc = JsonDocument.Parse("""{"snapshot":{"health":{"ok":true}}}""");
        _adapter.RouteEvent("snapshot", doc.RootElement.Clone());

        received.Should().BeTrue();
    }

    [Fact]
    public void RouteEvent_SeqGap_FiresGatewaySeqGap()
    {
        var fired = 0;
        _adapter.GatewaySeqGap += () => fired++;

        _adapter.RouteEvent("seqGap", null);

        fired.Should().Be(1);
    }

    // ── RouteEvent: presence ──────────────────────────────────────────────────

    [Fact]
    public void RouteEvent_Presence_FiresPresenceReceived()
    {
        JsonElement? received = null;
        _adapter.PresenceReceived += p => received = p;

        using var doc = JsonDocument.Parse("""{"presence":[]}""");
        _adapter.RouteEvent("presence", doc.RootElement.Clone());

        received.Should().NotBeNull();
    }

    // ── RouteEvent: cron ──────────────────────────────────────────────────────

    [Fact]
    public void RouteEvent_Cron_CallsHandleCronEvent()
    {
        // SelectedJobId must match for the runs-refresh signal to be set —
        // verify the cron event reaches the store at all.
        _cronJobs.SelectedJobId = "job-1";
        using var doc = JsonDocument.Parse("""{"jobId":"job-1","action":"finished"}""");

        _adapter.RouteEvent("cron", doc.RootElement.Clone());

        var (pending, jobId) = _cronJobs.ConsumeRunsRefreshSignal();
        pending.Should().BeTrue();
        jobId.Should().Be("job-1");
    }

    // ── RouteEvent: agent ─────────────────────────────────────────────────────

    [Fact]
    public void RouteEvent_Agent_AppendedToAgentEventStore()
    {
        using var doc = JsonDocument.Parse(
            """{"runId":"run-1","seq":1,"stream":"job","ts":1700000000,"summary":null}""");

        _adapter.RouteEvent("agent", doc.RootElement.Clone());

        _agentEvents.Events.Should().ContainSingle(e => e.RunId == "run-1");
    }

    [Fact]
    public void RouteEvent_Agent_JobStream_CallsWorkActivityHandleJob()
    {
        using var doc = JsonDocument.Parse(
            """{"runId":"r","seq":1,"stream":"job","ts":0,"data":{"sessionKey":"main","state":"started"}}""");

        _adapter.RouteEvent("agent", doc.RootElement.Clone());

        _workActivity.Current.Should().NotBeNull();
        _workActivity.Current!.Kind.Should().BeOfType<ActivityKind.Job>();
    }

    [Fact]
    public void RouteEvent_Agent_ToolStream_CallsWorkActivityHandleTool()
    {
        // Job must be started before a tool event takes effect.
        using var jobDoc = JsonDocument.Parse(
            """{"runId":"r","seq":1,"stream":"job","ts":0,"data":{"sessionKey":"main","state":"started"}}""");
        _adapter.RouteEvent("agent", jobDoc.RootElement.Clone());

        using var toolDoc = JsonDocument.Parse(
            """{"runId":"r","seq":2,"stream":"tool","ts":0,"data":{"sessionKey":"main","phase":"start","name":"bash"}}""");
        _adapter.RouteEvent("agent", toolDoc.RootElement.Clone());

        _workActivity.LastToolLabel.Should().Be("Bash");
    }

    // ── RouteEvent: pairing ───────────────────────────────────────────────────

    [Fact]
    public void RouteEvent_DevicePairRequested_FiresEvent()
    {
        JsonElement? received = null;
        _adapter.DevicePairRequested += p => received = p;

        using var doc = JsonDocument.Parse("""{"requestId":"req-1"}""");
        _adapter.RouteEvent("device.pair.requested", doc.RootElement.Clone());

        received.Should().NotBeNull();
    }

    [Fact]
    public void RouteEvent_NodePairRequested_FiresEvent()
    {
        JsonElement? received = null;
        _adapter.NodePairRequested += p => received = p;

        using var doc = JsonDocument.Parse("""{"requestId":"req-2"}""");
        _adapter.RouteEvent("node.pair.requested", doc.RootElement.Clone());

        received.Should().NotBeNull();
    }

    [Fact]
    public void RouteEvent_ExecApprovalRequested_FiresEvent()
    {
        JsonElement? received = null;
        _adapter.ExecApprovalRequested += p => received = p;

        using var doc = JsonDocument.Parse("""{"requestId":"exec-1"}""");
        _adapter.RouteEvent("exec.approval.requested", doc.RootElement.Clone());

        received.Should().NotBeNull();
    }

    // ── RouteResponse ─────────────────────────────────────────────────────────

    [Fact]
    public void RouteResponse_UnknownId_DoesNotThrow()
    {
        // No pending request with this ID — must be silently ignored.
        var act = () => _adapter.RouteResponse("no-such-id", true, null, null);
        act.Should().NotThrow();
    }

    [Fact]
    public async Task RouteResponse_OkTrue_CompletesPendingRequest()
    {
        // Capture the request ID that the adapter sends via the WS.
        var idCapture = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ws.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                using var doc = JsonDocument.Parse(call.Arg<string>());
                idCapture.TrySetResult(doc.RootElement.GetProperty("id").GetString()!);
                return Task.FromResult<ErrorOr<Success>>(Result.Success);
            });

        // Start a request — don't await yet.
        var requestTask = _adapter.RequestRawAsync("health", timeoutMs: 5000);

        var id = await idCapture.Task.WaitAsync(TimeSpan.FromSeconds(5));

        using var payloadDoc = JsonDocument.Parse("""{"ok":true}""");
        _adapter.RouteResponse(id, true, payloadDoc.RootElement.Clone(), null);

        var bytes = await requestTask.WaitAsync(TimeSpan.FromSeconds(5));
        bytes.Should().NotBeNull();
    }

    [Fact]
    public async Task RouteResponse_OkFalse_ThrowsGatewayResponseException()
    {
        var idCapture = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ws.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                using var doc = JsonDocument.Parse(call.Arg<string>());
                idCapture.TrySetResult(doc.RootElement.GetProperty("id").GetString()!);
                return Task.FromResult<ErrorOr<Success>>(Result.Success);
            });

        var requestTask = _adapter.RequestRawAsync("health", timeoutMs: 5000);

        var id = await idCapture.Task.WaitAsync(TimeSpan.FromSeconds(5));

        using var errDoc = JsonDocument.Parse("""{"code":"HEALTH-FAIL","message":"gateway down"}""");
        _adapter.RouteResponse(id, false, null, errDoc.RootElement.Clone());

        Func<Task> act = async () => await requestTask.WaitAsync(TimeSpan.FromSeconds(5));
        await act.Should().ThrowAsync<GatewayResponseException>();
    }
}
