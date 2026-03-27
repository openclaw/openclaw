using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Gateway;

namespace OpenClawWindows.Tests.Integration.Tunnel;

// Integration: NullRemoteTunnelService + ApplyConnectionModeHandler + GatewayConnection.
// Verifies connection mode resolution, tunnel lifecycle, and disconnect-if-needed behavior.
public sealed class RemoteTunnelLifecycleTests
{
    private readonly GatewayConnection    _connection     = GatewayConnection.Create("openclaw-control-ui");
    private readonly IGatewayWebSocket    _ws             = Substitute.For<IGatewayWebSocket>();
    private readonly IGatewayProcessManager _processManager = Substitute.For<IGatewayProcessManager>();

    public RemoteTunnelLifecycleTests()
    {
        _processManager
            .WaitForGatewayReadyAsync(Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>())
            .Returns(true);
    }

    // ── NullRemoteTunnelService contract ──────────────────────────────────────

    [Fact]
    public void NullTunnel_IsConnected_AlwaysFalse()
    {
        var tunnel = new NullRemoteTunnelService();
        tunnel.IsConnected.Should().BeFalse();
    }

    [Fact]
    public async Task NullTunnel_ConnectAsync_ReturnsFailure()
    {
        var tunnel = new NullRemoteTunnelService();

        var result = await tunnel.ConnectAsync("user@host", 18789, 18789, CancellationToken.None);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("tunnel.not_implemented");
    }

    [Fact]
    public async Task NullTunnel_DisconnectAsync_IsGraceful()
    {
        var tunnel = new NullRemoteTunnelService();

        var act = () => tunnel.DisconnectAsync(CancellationToken.None);

        await act.Should().NotThrowAsync();
    }

    // ── ApplyConnectionModeHandler — Unconfigured ──────────────────────────────

    [Fact]
    public async Task ApplyMode_Unconfigured_DisconnectsAndReturnSuccess()
    {
        _ws.DisconnectAsync().Returns(Task.CompletedTask);
        var mediator = Substitute.For<IMediator>();
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.DisconnectAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);
        mediator.Send(Arg.Any<DisconnectFromGatewayCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        var handler = new ApplyConnectionModeHandler(
            mediator, _connection, tunnel, _processManager,
            NullLogger<ApplyConnectionModeHandler>.Instance);

        var settings = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        // ConnectionMode.Unconfigured is the default
        var result = await handler.Handle(new ApplyConnectionModeCommand(settings), default);

        result.IsError.Should().BeFalse();
        await tunnel.Received(1).DisconnectAsync(Arg.Any<CancellationToken>());
        // Connection was already Disconnected so DisconnectFromGateway should NOT be sent
        await mediator.DidNotReceive().Send(
            Arg.Any<DisconnectFromGatewayCommand>(), Arg.Any<CancellationToken>());
    }

    // ── ApplyConnectionModeHandler — Local ────────────────────────────────────

    [Fact]
    public async Task ApplyMode_Local_StopsTunnelAndReturnsSuccess()
    {
        var mediator = Substitute.For<IMediator>();
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.DisconnectAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);

        var handler = new ApplyConnectionModeHandler(
            mediator, _connection, tunnel, _processManager,
            NullLogger<ApplyConnectionModeHandler>.Instance);

        var settings = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        settings.SetConnectionMode(ConnectionMode.Local);
        settings.SetOnboardingSeen(true);

        var result = await handler.Handle(new ApplyConnectionModeCommand(settings), default);

        result.IsError.Should().BeFalse();
        await tunnel.Received(1).DisconnectAsync(Arg.Any<CancellationToken>());
    }

    // ── ApplyConnectionModeHandler — Remote Direct ────────────────────────────

    [Fact]
    public async Task ApplyMode_RemoteDirect_StopsTunnelAndDoesNotConnect()
    {
        var mediator = Substitute.For<IMediator>();
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.DisconnectAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);

        var handler = new ApplyConnectionModeHandler(
            mediator, _connection, tunnel, _processManager,
            NullLogger<ApplyConnectionModeHandler>.Instance);

        var settings = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        settings.SetConnectionMode(ConnectionMode.Remote);
        settings.SetRemoteTransport(RemoteTransport.Direct);
        settings.SetRemoteUrl("wss://myserver.example.com");

        var result = await handler.Handle(new ApplyConnectionModeCommand(settings), default);

        result.IsError.Should().BeFalse();
        await tunnel.Received(1).DisconnectAsync(Arg.Any<CancellationToken>());
        // Direct mode — tunnel.ConnectAsync must NOT be called
        await tunnel.DidNotReceive().ConnectAsync(
            Arg.Any<string>(), Arg.Any<int>(), Arg.Any<int>(), Arg.Any<CancellationToken>());
    }

    // ── ApplyConnectionModeHandler — Remote SSH ───────────────────────────────

    [Fact]
    public async Task ApplyMode_RemoteSsh_AttemptsTunnelConnect()
    {
        var mediator = Substitute.For<IMediator>();
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        var handler = new ApplyConnectionModeHandler(
            mediator, _connection, tunnel, _processManager,
            NullLogger<ApplyConnectionModeHandler>.Instance);

        var settings = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        settings.SetConnectionMode(ConnectionMode.Remote);
        settings.SetRemoteTransport(RemoteTransport.Ssh);
        settings.SetRemoteTarget("myserver.example.com");

        var result = await handler.Handle(new ApplyConnectionModeCommand(settings), default);

        result.IsError.Should().BeFalse();
        await tunnel.Received(1).ConnectAsync(
            "myserver.example.com", 18789, 18789, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ApplyMode_RemoteSsh_TunnelFails_NonFatal()
    {
        var mediator = Substitute.For<IMediator>();
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.ConnectAsync(Arg.Any<string>(), Arg.Any<int>(), Arg.Any<int>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(
                Error.Failure("tunnel.failed", "SSH rejected")));

        var handler = new ApplyConnectionModeHandler(
            mediator, _connection, tunnel, _processManager,
            NullLogger<ApplyConnectionModeHandler>.Instance);

        var settings = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        settings.SetConnectionMode(ConnectionMode.Remote);
        settings.SetRemoteTransport(RemoteTransport.Ssh);
        settings.SetRemoteTarget("myserver.example.com");

        // Tunnel failure is non-fatal — coordinator will retry
        var result = await handler.Handle(new ApplyConnectionModeCommand(settings), default);

        result.IsError.Should().BeFalse();
    }

    // ── Mode resolution via OnboardingSeen ────────────────────────────────────

    [Fact]
    public async Task ApplyMode_UnconfiguredModeButOnboardingSeen_ResolvesToLocal()
    {
        var mediator = Substitute.For<IMediator>();
        var tunnel = Substitute.For<IRemoteTunnelService>();
        tunnel.DisconnectAsync(Arg.Any<CancellationToken>()).Returns(Task.CompletedTask);

        var handler = new ApplyConnectionModeHandler(
            mediator, _connection, tunnel, _processManager,
            NullLogger<ApplyConnectionModeHandler>.Instance);

        var settings = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        // ConnectionMode stays Unconfigured but OnboardingSeen=true → resolved to Local
        settings.SetOnboardingSeen(true);

        var result = await handler.Handle(new ApplyConnectionModeCommand(settings), default);

        result.IsError.Should().BeFalse();
        // Local mode calls DisconnectAsync on the tunnel
        await tunnel.Received(1).DisconnectAsync(Arg.Any<CancellationToken>());
    }
}
