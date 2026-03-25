using MediatR;
using OpenClawWindows.Application.NodeMode;
using OpenClawWindows.Application.ScreenCapture;

namespace OpenClawWindows.Tests.Unit.Application.NodeMode;

public sealed class NodeScreenCommandsHandlerTests
{
    private readonly ISender _sender = Substitute.For<ISender>();
    private readonly NodeScreenCommandsHandler _handler;

    public NodeScreenCommandsHandlerTests()
    {
        _handler = new NodeScreenCommandsHandler(_sender);
    }

    // ── Valid JSON pass-through ────────────────────────────────────────────────

    [Fact]
    public async Task Handle_ValidJson_PassesThroughJsonToScreenRecordCommand()
    {
        var json = """{"format":"mp4","durationMs":5000,"fps":10}""";
        var ok = ScreenRecordingResult.Create(Convert.ToBase64String([0x00]), 5000, 10.0f, 0, false).Value;
        _sender.Send(Arg.Any<ScreenRecordCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<ScreenRecordingResult>>(ok));

        await _handler.Handle(new NodeScreenRecordCommand(json), CancellationToken.None);

        await _sender.Received(1).Send(
            Arg.Is<ScreenRecordCommand>(c => c.ParamsJson == json),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ValidEmptyObject_PassesThroughToScreenRecordCommand()
    {
        var ok = ScreenRecordingResult.Create(Convert.ToBase64String([0x00]), 10000, 10.0f, 0, false).Value;
        _sender.Send(Arg.Any<ScreenRecordCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<ScreenRecordingResult>>(ok));

        await _handler.Handle(new NodeScreenRecordCommand("{}"), CancellationToken.None);

        await _sender.Received(1).Send(
            Arg.Is<ScreenRecordCommand>(c => c.ParamsJson == "{}"),
            Arg.Any<CancellationToken>());
    }

    // ── Malformed JSON fallback (mirrors Swift: try? decodeParams(..) ?? MacNodeScreenRecordParams()) ──

    [Fact]
    public async Task Handle_MalformedJson_FallsBackToEmptyObject()
    {
        var ok = ScreenRecordingResult.Create(Convert.ToBase64String([0x00]), 10000, 10.0f, 0, false).Value;
        _sender.Send(Arg.Any<ScreenRecordCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<ScreenRecordingResult>>(ok));

        await _handler.Handle(new NodeScreenRecordCommand("{not valid json"), CancellationToken.None);

        await _sender.Received(1).Send(
            Arg.Is<ScreenRecordCommand>(c => c.ParamsJson == "{}"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_EmptyString_FallsBackToEmptyObject()
    {
        var ok = ScreenRecordingResult.Create(Convert.ToBase64String([0x00]), 10000, 10.0f, 0, false).Value;
        _sender.Send(Arg.Any<ScreenRecordCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<ScreenRecordingResult>>(ok));

        await _handler.Handle(new NodeScreenRecordCommand(""), CancellationToken.None);

        await _sender.Received(1).Send(
            Arg.Is<ScreenRecordCommand>(c => c.ParamsJson == "{}"),
            Arg.Any<CancellationToken>());
    }

    // ── Error propagation ──────────────────────────────────────────────────────

    [Fact]
    public async Task Handle_ScreenRecordCommandError_Propagates()
    {
        _sender.Send(Arg.Any<ScreenRecordCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<ScreenRecordingResult>>(
                Error.Failure("SCR-001", "INVALID_REQUEST: screen format must be mp4")));

        var result = await _handler.Handle(
            new NodeScreenRecordCommand("""{"format":"avi"}"""), CancellationToken.None);

        result.IsError.Should().BeTrue();
        result.FirstError.Description.Should().Be("INVALID_REQUEST: screen format must be mp4");
    }
}
