using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.NodeMode;

namespace OpenClawWindows.Tests.Unit.Application.NodeMode;

// Mirrors macOS MacNodeRuntimeTests — verifies NodeInvokeDispatcher routing behavior.
public sealed class NodeInvokeDispatcherTests
{
    private readonly IMediator           _mediator   = Substitute.For<IMediator>();
    private readonly NodeInvokeDispatcher _dispatcher;

    public NodeInvokeDispatcherTests()
    {
        _dispatcher = new NodeInvokeDispatcher(
            _mediator,
            NullLogger<NodeInvokeDispatcher>.Instance);
    }

    // Mirrors Swift: @Test func `handle invoke rejects unknown command`()
    [Fact]
    public async Task Handle_UnknownCommand_ReturnsError()
    {
        var cmd = new DispatchNodeInvokeCommand(
            new NodeInvokeRequest("req-1", "unknown.command.xyz", "{}"));

        var response = await _dispatcher.Handle(cmd, CancellationToken.None);

        Assert.False(response.Ok);
        Assert.NotNull(response.Error);
        Assert.Contains("Unknown command", response.Error);
    }

    // Guard: Id echoed back verbatim in error responses.
    [Fact]
    public async Task Handle_UnknownCommand_EchoesRequestId()
    {
        var cmd = new DispatchNodeInvokeCommand(
            new NodeInvokeRequest("my-id-42", "bad.command", "{}"));

        var response = await _dispatcher.Handle(cmd, CancellationToken.None);

        Assert.Equal("my-id-42", response.Id);
    }
}
