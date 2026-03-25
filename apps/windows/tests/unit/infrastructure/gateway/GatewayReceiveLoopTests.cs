using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading.Channels;
using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Gateway;

public sealed class GatewayReceiveLoopTests
{
    private readonly IGatewayWebSocket _ws = Substitute.For<IGatewayWebSocket>();
    private readonly RouterSpy _router = new();
    private readonly GatewayConnection _connection = GatewayConnection.Create("openclaw-control-ui");
    private readonly InMemoryWorkActivityStore _workActivity = new();
    private readonly ISettingsRepository _settings = Substitute.For<ISettingsRepository>();
    private readonly ISender _sender = Substitute.For<ISender>();
    private readonly GatewayReceiveLoopHostedService _service;

    public GatewayReceiveLoopTests()
    {
        _settings.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(AppSettings.WithDefaults(@"C:\AppData\OpenClaw")));

        _service = new GatewayReceiveLoopHostedService(
            _ws, _router, _connection, _workActivity, _settings, _sender, TimeProvider.System,
            NullLogger<GatewayReceiveLoopHostedService>.Instance);

        _ws.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));
    }

    // ── "res" frame routing ────────────────────────────────────────────────────

    [Fact]
    public async Task DispatchResFrame_RoutesToRouter()
    {
        var routed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _router.OnResponse += _ => routed.TrySetResult();

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("""{"type":"res","id":"req-abc","ok":true,"payload":{}}""");

        await routed.Task.WaitAsync(TimeSpan.FromSeconds(5));

        await _service.StopAsync(CancellationToken.None);

        _router.Responses.Should().ContainSingle(r => r.Id == "req-abc" && r.Ok);
    }

    [Fact]
    public async Task DispatchResFrame_OkFalse_RoutesErrorToRouter()
    {
        var routed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _router.OnResponse += _ => routed.TrySetResult();

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("""{"type":"res","id":"req-err","ok":false,"error":{"code":"E","message":"fail"}}""");

        await routed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await _service.StopAsync(CancellationToken.None);

        _router.Responses.Should().ContainSingle(r => r.Id == "req-err" && !r.Ok);
    }

    // ── "event" frame routing ──────────────────────────────────────────────────

    [Fact]
    public async Task DispatchEventFrame_RoutesToRouter()
    {
        var routed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _router.OnEvent += _ => routed.TrySetResult();

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("""{"type":"event","event":"presence","payload":{"presence":[]}}""");

        await routed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await _service.StopAsync(CancellationToken.None);

        _router.Events.Should().ContainSingle(e => e.EventName == "presence");
    }

    // ── connect.challenge handshake ───────────────────────────────────────────

    [Fact]
    public async Task DispatchConnectChallenge_SendsConnectRequest()
    {
        var sendReceived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _ws.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                using var doc = JsonDocument.Parse(call.Arg<string>());
                if (doc.RootElement.TryGetProperty("method", out var m) && m.GetString() == "connect")
                    sendReceived.TrySetResult();
                return Task.FromResult<ErrorOr<Success>>(Result.Success);
            });

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("""{"type":"event","event":"connect.challenge"}""");

        await sendReceived.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await _service.StopAsync(CancellationToken.None);

        await _ws.Received().SendAsync(
            Arg.Is<string>(s => s.Contains("\"method\":\"connect\"")),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ConnectHandshake_HelloOk_MarksConnectionConnected()
    {
        // Pre-condition: connection must be in Connecting state for MarkConnected to succeed.
        _connection.MarkConnecting();

        string? connectRequestId = null;
        var connectSent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _ws.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                using var doc = JsonDocument.Parse(call.Arg<string>());
                if (doc.RootElement.TryGetProperty("method", out var m) && m.GetString() == "connect")
                {
                    connectRequestId = doc.RootElement.GetProperty("id").GetString()!;
                    connectSent.TrySetResult();
                }
                return Task.FromResult<ErrorOr<Success>>(Result.Success);
            });

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        // Trigger the challenge
        await ch.Writer.WriteAsync("""{"type":"event","event":"connect.challenge"}""");
        await connectSent.Task.WaitAsync(TimeSpan.FromSeconds(5));

        // Respond with hello-ok; ApplyHelloOk calls SetMainSessionKey so we can use it as sentinel.
        // Raw string interpolation can't embed consecutive `}` — use concat to avoid CS9007
        var helloOk = "{\"type\":\"res\",\"id\":\"" + connectRequestId
            + "\",\"ok\":true,\"payload\":{\"snapshot\":{\"sessiondefaults\":{\"mainSessionKey\":\"global\"}}}}";
        await ch.Writer.WriteAsync(helloOk);

        // Poll until the session key propagates (SetMainSessionKey is called inside ApplyHelloOk).
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (_workActivity.MainSessionKey != "global" && DateTime.UtcNow < deadline)
            await Task.Delay(10);

        await _service.StopAsync(CancellationToken.None);

        _connection.State.Should().Be(GatewayConnectionState.Connected);
        _workActivity.MainSessionKey.Should().Be("global");
    }

    // ── Handshake failure recovery ────────────────────────────────────────────

    [Fact]
    public async Task ConnectHandshake_HelloNotOk_MarksConnectionDisconnected()
    {
        _connection.MarkConnecting();

        string? connectRequestId = null;
        var connectSent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        _ws.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                using var doc = JsonDocument.Parse(call.Arg<string>());
                if (doc.RootElement.TryGetProperty("method", out var m) && m.GetString() == "connect")
                {
                    connectRequestId = doc.RootElement.GetProperty("id").GetString()!;
                    connectSent.TrySetResult();
                }
                return Task.FromResult<ErrorOr<Success>>(Result.Success);
            });

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("""{"type":"event","event":"connect.challenge"}""");
        await connectSent.Task.WaitAsync(TimeSpan.FromSeconds(5));

        var helloRejected = "{\"type\":\"res\",\"id\":\"" + connectRequestId
            + "\",\"ok\":false,\"error\":{\"code\":\"AUTH\",\"message\":\"unauthorized\"}}";
        await ch.Writer.WriteAsync(helloRejected);

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (_connection.State != GatewayConnectionState.Disconnected && DateTime.UtcNow < deadline)
            await Task.Delay(10);

        await _service.StopAsync(CancellationToken.None);

        _connection.State.Should().Be(GatewayConnectionState.Disconnected);
    }

    [Fact]
    public async Task SocketClosedDuringConnecting_MarksConnectionDisconnected()
    {
        _connection.MarkConnecting();

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        // Simulate WS closing before hello-ok
        ch.Writer.Complete();

        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (_connection.State != GatewayConnectionState.Disconnected && DateTime.UtcNow < deadline)
            await Task.Delay(10);

        await _service.StopAsync(CancellationToken.None);

        _connection.State.Should().Be(GatewayConnectionState.Disconnected);
    }

    // ── Resilience ────────────────────────────────────────────────────────────

    [Fact]
    public async Task DispatchMalformedJson_DoesNotCrash()
    {
        var processed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // Deliver malformed JSON then a valid frame so we can tell when processing resumed.
        _router.OnEvent += _ => processed.TrySetResult();

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("{broken json}");
        // After the malformed frame, send a valid one to confirm loop is still running.
        await ch.Writer.WriteAsync("""{"type":"event","event":"test.event","payload":{}}""");

        await processed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await _service.StopAsync(CancellationToken.None);

        _router.Events.Should().ContainSingle(e => e.EventName == "test.event");
    }

    [Fact]
    public async Task DispatchUnknownFrameType_DoesNotCrash()
    {
        var processed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        _router.OnEvent += _ => processed.TrySetResult();

        var ch = SetupChannel();
        await _service.StartAsync(CancellationToken.None);

        await ch.Writer.WriteAsync("""{"type":"unknown","data":"x"}""");
        await ch.Writer.WriteAsync("""{"type":"event","event":"ping"}""");

        await processed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await _service.StopAsync(CancellationToken.None);

        _router.Events.Should().ContainSingle(e => e.EventName == "ping");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private Channel<string> SetupChannel()
    {
        var ch = Channel.CreateUnbounded<string>();
        _ws.ReceiveMessagesAsync(Arg.Any<CancellationToken>())
            .Returns(call => ch.Reader.ReadAllAsync(call.Arg<CancellationToken>()));
        return ch;
    }

    // In-process spy for the internal IGatewayMessageRouter interface.
    private sealed class RouterSpy : IGatewayMessageRouter
    {
        public readonly List<(string Id, bool Ok)> Responses = new();
        public readonly List<(string EventName, JsonElement? Payload)> Events = new();
        public event Action<(string Id, bool Ok)>? OnResponse;
        public event Action<(string EventName, JsonElement? Payload)>? OnEvent;

        public void RouteResponse(string id, bool ok, JsonElement? payload, JsonElement? error)
        {
            var entry = (id, ok);
            Responses.Add(entry);
            OnResponse?.Invoke(entry);
        }

        public void RouteEvent(string eventName, JsonElement? payload)
        {
            var entry = (eventName, payload);
            Events.Add(entry);
            OnEvent?.Invoke(entry);
        }

        public int HandshakeCompleteCount { get; private set; }
        public int HandshakeResetCount { get; private set; }
        public void NotifyHandshakeComplete() => HandshakeCompleteCount++;
        public void ResetHandshakeGate() => HandshakeResetCount++;
    }
}
