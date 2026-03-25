using System.Reflection;
using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Integration.Gateway;

// Integration: GatewayReconnectCoordinatorHostedService + GatewayConnection + IMediator.
// Verifies the full connect/reconnect/backoff lifecycle without a real WebSocket.
public sealed class GatewayLifecycleTests
{
    private static readonly MethodInfo ComputeBackoffMsMethod =
        typeof(GatewayReconnectCoordinatorHostedService)
            .GetMethod("ComputeBackoffMs", BindingFlags.NonPublic | BindingFlags.Static)!;

    private static int InvokeComputeBackoffMs(int attempt)
        => (int)ComputeBackoffMsMethod.Invoke(null, [attempt])!;

    // ── Backoff calculation ────────────────────────────────────────────────────

    [Fact]
    public void Backoff_Attempt0_IsAtLeast500ms()
    {
        var ms = InvokeComputeBackoffMs(0);
        ms.Should().BeGreaterThanOrEqualTo(500);
    }

    [Fact]
    public void Backoff_Attempt0_IsBelowMaxDelay()
    {
        var ms = InvokeComputeBackoffMs(0);
        // Base 2s ± 30% jitter — never exceeds 2600ms for attempt 0
        ms.Should().BeLessThanOrEqualTo(2_600);
    }

    [Fact]
    public void Backoff_IncreasesWithAttemptNumber()
    {
        // Run many samples to overcome jitter and verify average trend
        var avg0 = Enumerable.Range(0, 50).Average(_ => InvokeComputeBackoffMs(0));
        var avg3 = Enumerable.Range(0, 50).Average(_ => InvokeComputeBackoffMs(3));

        avg3.Should().BeGreaterThan(avg0);
    }

    [Fact]
    public void Backoff_CapsAtMaxDelay()
    {
        // At a very high attempt count the base is capped at 60s before jitter
        for (var i = 0; i < 20; i++)
        {
            var ms = InvokeComputeBackoffMs(10);
            // 60s ± 30% = max 78s; floor 500ms
            ms.Should().BeInRange(500, 78_000);
        }
    }

    [Fact]
    public void Backoff_HasFloorAt500ms()
    {
        for (var i = 0; i < 50; i++)
        {
            var ms = InvokeComputeBackoffMs(0);
            ms.Should().BeGreaterThanOrEqualTo(500);
        }
    }

    // ── GatewayConnection state machine ──────────────────────────────────────

    [Fact]
    public void Connection_InitialState_IsDisconnected()
    {
        var conn = GatewayConnection.Create("openclaw-control-ui");
        conn.State.Should().Be(GatewayConnectionState.Disconnected);
    }

    [Fact]
    public void Connection_MarkConnecting_TransitionsToConnecting()
    {
        var conn = GatewayConnection.Create("openclaw-control-ui");
        conn.MarkConnecting();
        conn.State.Should().Be(GatewayConnectionState.Connecting);
    }

    [Fact]
    public void Connection_MarkConnected_ToleratesAnyState()
    {
        var conn = GatewayConnection.Create("openclaw-control-ui");
        // Tolerates connecting from Disconnected — reconnect races need flexibility.
        conn.MarkConnected("global", null, TimeProvider.System);
        conn.State.Should().Be(GatewayConnectionState.Connected);
        conn.SessionKey.Should().Be("global");
    }

    [Fact]
    public void Connection_MarkConnected_SetsSessionKey()
    {
        var conn = GatewayConnection.Create("openclaw-control-ui");
        conn.MarkConnecting();
        conn.MarkConnected("global", "http://canvas.local", TimeProvider.System);

        conn.State.Should().Be(GatewayConnectionState.Connected);
        conn.SessionKey.Should().Be("global");
        conn.CanvasHostUrl.Should().Be("http://canvas.local");
    }

    // ── Coordinator: no endpoint → no connect attempt ─────────────────────────

    [Fact]
    public async Task Coordinator_NoGatewayEndpoint_DoesNotSendConnectCommand()
    {
        var mediator = Substitute.For<IMediator>();
        var settings = Substitute.For<ISettingsRepository>();
        // Return settings with no GatewayEndpointUri and onboarding not seen
        settings.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(AppSettings.WithDefaults(@"C:\AppData\OpenClaw"));

        var connection = GatewayConnection.Create("openclaw-control-ui");

        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.IsConnected.Returns(true);

        var svc = new GatewayReconnectCoordinatorHostedService(
            settings, mediator, connection, tunnel,
            NullLogger<GatewayReconnectCoordinatorHostedService>.Instance);

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await svc.StartAsync(cts.Token);
        await Task.Delay(1500, CancellationToken.None);
        await svc.StopAsync(CancellationToken.None);

        // No endpoint resolved → no connect/reconnect command sent
        await mediator.DidNotReceive().Send(
            Arg.Any<ConnectToGatewayCommand>(), Arg.Any<CancellationToken>());
    }

    // ── Connect → Disconnect sequence ────────────────────────────────────────

    [Fact]
    public async Task ConnectHandler_WebSocketThrows_ReturnsError()
    {
        var ws = Substitute.For<IGatewayWebSocket>();
        ws.ConnectAsync(Arg.Any<GatewayEndpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new Exception("connection refused")));

        var connection = GatewayConnection.Create("openclaw-control-ui");
        var handler = new ConnectToGatewayHandler(
            ws, connection, Substitute.For<ISender>(), NullLogger<ConnectToGatewayHandler>.Instance);

        var endpoint = GatewayEndpoint.Create("ws://localhost:18789", "Local").Value;
        var result = await handler.Handle(new ConnectToGatewayCommand(endpoint), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("GW-CONNECT");
        connection.State.Should().Be(GatewayConnectionState.Disconnected);
    }

    [Fact]
    public async Task ConnectHandler_WebSocketSucceeds_LeavesConnectionConnecting()
    {
        var ws = Substitute.For<IGatewayWebSocket>();
        ws.ConnectAsync(Arg.Any<GatewayEndpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var connection = GatewayConnection.Create("openclaw-control-ui");
        var handler = new ConnectToGatewayHandler(
            ws, connection, Substitute.For<ISender>(), NullLogger<ConnectToGatewayHandler>.Instance);

        var endpoint = GatewayEndpoint.Create("ws://localhost:18789", "Local").Value;
        var result = await handler.Handle(new ConnectToGatewayCommand(endpoint), default);

        result.IsError.Should().BeFalse();
        // State is Connecting — hello-ok completes the handshake separately
        connection.State.Should().Be(GatewayConnectionState.Connecting);
    }

    [Fact]
    public async Task DisconnectHandler_AnyState_DisconnectsAndReturnsSuccess()
    {
        var ws = Substitute.For<IGatewayWebSocket>();
        ws.ConnectAsync(Arg.Any<GatewayEndpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        ws.DisconnectAsync().Returns(Task.CompletedTask);

        var connection = GatewayConnection.Create("openclaw-control-ui");
        // Put connection into Connecting state first
        var endpoint = GatewayEndpoint.Create("ws://localhost:18789", "Local").Value;
        var connectHandler = new ConnectToGatewayHandler(
            ws, connection, Substitute.For<ISender>(), NullLogger<ConnectToGatewayHandler>.Instance);
        await connectHandler.Handle(new ConnectToGatewayCommand(endpoint), default);

        var disconnectHandler = new DisconnectFromGatewayHandler(
            ws, connection, Substitute.For<ISender>(), NullLogger<DisconnectFromGatewayHandler>.Instance);
        var result = await disconnectHandler.Handle(
            new DisconnectFromGatewayCommand("test"), default);

        result.IsError.Should().BeFalse();
        connection.State.Should().Be(GatewayConnectionState.Disconnected);
    }
}
