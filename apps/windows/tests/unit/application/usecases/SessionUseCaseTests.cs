using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Sessions;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway.Events;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class CreateSessionHandlerTests
{
    private readonly IMediator _mediator = Substitute.For<IMediator>();
    private readonly InMemorySessionStore _store = new();
    private readonly CreateSessionHandler _handler;

    public CreateSessionHandlerTests()
    {
        _handler = new CreateSessionHandler(
            _store, _mediator,
            TimeProvider.System,
            NullLogger<CreateSessionHandler>.Instance);
    }

    [Fact]
    public async Task Handle_AddsSessionToStore()
    {
        await _handler.Handle(new GatewayConnected { SessionKey = "session-abc" }, default);

        _store.ActiveCount.Should().Be(1);
    }

    [Fact]
    public async Task Handle_SendsUpdateTrayMenuState()
    {
        await _handler.Handle(new GatewayConnected { SessionKey = "main" }, default);

        await _mediator.Received(1).Send(
            Arg.Is<UpdateTrayMenuStateCommand>(c => c.ConnectionState == "Connected"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_TrayMenuIncludesSessionCount()
    {
        await _handler.Handle(new GatewayConnected { SessionKey = "s1" }, default);
        await _handler.Handle(new GatewayConnected { SessionKey = "s2" }, default);

        await _mediator.Received(1).Send(
            Arg.Is<UpdateTrayMenuStateCommand>(c => c.ActiveSessionLabel!.Contains("2")),
            Arg.Any<CancellationToken>());
    }
}
