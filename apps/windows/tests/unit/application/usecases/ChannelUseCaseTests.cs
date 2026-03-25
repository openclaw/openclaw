using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Channels;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway.Events;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class SubscribeChannelHandlerTests
{
    private readonly IGatewayWebSocket _socket = Substitute.For<IGatewayWebSocket>();
    private readonly InMemoryChannelStore _store = new();
    private readonly SubscribeChannelHandler _handler;

    public SubscribeChannelHandlerTests()
    {
        _handler = new SubscribeChannelHandler(
            _socket, _store,
            NullLogger<SubscribeChannelHandler>.Instance);

        _socket.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Result.Success);
    }

    [Fact]
    public async Task Handle_ValidChannel_SendsSubscribeMessage()
    {
        await _handler.Handle(new SubscribeChannelCommand("ch-slack"), default);

        await _socket.Received(1).SendAsync(
            Arg.Is<string>(s => s.Contains("channel.subscribe") && s.Contains("ch-slack")),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ValidChannel_RegistersInStore()
    {
        await _handler.Handle(new SubscribeChannelCommand("ch-slack"), default);

        _store.GetActive().Should().Contain("ch-slack");
    }

    [Fact]
    public async Task Handle_SocketError_ReturnsError()
    {
        _socket.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Error.Failure("WS-SEND", "write failed"));

        var result = await _handler.Handle(new SubscribeChannelCommand("ch-1"), default);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public async Task Handle_SocketError_DoesNotRegisterChannel()
    {
        _socket.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Error.Failure("WS-SEND", "write failed"));

        await _handler.Handle(new SubscribeChannelCommand("ch-1"), default);

        _store.GetActive().Should().BeEmpty();
    }
}

public sealed class ResubscribeChannelsOnConnectHandlerTests
{
    private readonly IGatewayWebSocket _socket = Substitute.For<IGatewayWebSocket>();
    private readonly InMemoryChannelStore _store = new();
    private readonly ResubscribeChannelsOnConnectHandler _handler;

    public ResubscribeChannelsOnConnectHandlerTests()
    {
        _handler = new ResubscribeChannelsOnConnectHandler(
            _socket, _store,
            NullLogger<ResubscribeChannelsOnConnectHandler>.Instance);

        _socket.SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Result.Success);
    }

    [Fact]
    public async Task Handle_NoActiveChannels_DoesNotSend()
    {
        await _handler.Handle(new GatewayConnected { SessionKey = "main" }, default);

        await _socket.DidNotReceive().SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_WithActiveChannels_ResubscribesAll()
    {
        _store.Register("ch-1");
        _store.Register("ch-2");

        await _handler.Handle(new GatewayConnected { SessionKey = "main" }, default);

        await _socket.Received(2).SendAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_SendsChannelSubscribeMessages()
    {
        _store.Register("ch-slack");

        await _handler.Handle(new GatewayConnected { SessionKey = "main" }, default);

        await _socket.Received(1).SendAsync(
            Arg.Is<string>(s => s.Contains("channel.subscribe") && s.Contains("ch-slack")),
            Arg.Any<CancellationToken>());
    }
}
