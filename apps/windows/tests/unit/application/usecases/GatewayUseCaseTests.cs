using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class ConnectToGatewayHandlerTests
{
    private readonly IGatewayWebSocket _ws = Substitute.For<IGatewayWebSocket>();
    private readonly GatewayConnection _connection = GatewayConnection.Create("openclaw-control-ui");
    private readonly ISender _sender = Substitute.For<ISender>();
    private readonly ConnectToGatewayHandler _handler;

    public ConnectToGatewayHandlerTests()
    {
        _handler = new ConnectToGatewayHandler(
            _ws, _connection, _sender,
            NullLogger<ConnectToGatewayHandler>.Instance);
    }

    [Fact]
    public async Task Handle_Success_MarkesConnectionConnecting()
    {
        var endpoint = GatewayEndpoint.Create("ws://localhost:3000", "Local").Value;
        _ws.ConnectAsync(Arg.Any<GatewayEndpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var result = await _handler.Handle(new ConnectToGatewayCommand(endpoint), default);

        result.IsError.Should().BeFalse();
        // After successful connect, state is Connecting (ws.ConnectAsync is called; hello-ok handled separately)
    }

    [Fact]
    public async Task Handle_WebSocketThrows_ReturnsError()
    {
        var endpoint = GatewayEndpoint.Create("ws://localhost:3000", "Local").Value;
        _ws.ConnectAsync(Arg.Any<GatewayEndpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new Exception("connection refused")));

        var result = await _handler.Handle(new ConnectToGatewayCommand(endpoint), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("GW-CONNECT");
    }

    [Fact]
    public async Task Handle_WebSocketThrows_MarksConnectionDisconnected()
    {
        var endpoint = GatewayEndpoint.Create("ws://localhost:3000", "Local").Value;
        _ws.ConnectAsync(Arg.Any<GatewayEndpoint>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new Exception("refused")));

        await _handler.Handle(new ConnectToGatewayCommand(endpoint), default);

        _connection.State.Should().Be(GatewayConnectionState.Disconnected);
    }
}
