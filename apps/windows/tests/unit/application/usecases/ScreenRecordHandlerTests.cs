using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.ScreenCapture;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class ScreenRecordHandlerTests
{
    private readonly IScreenCapture _screen = Substitute.For<IScreenCapture>();
    private readonly IAuditLogger _audit = Substitute.For<IAuditLogger>();
    private readonly ScreenRecordHandler _handler;

    public ScreenRecordHandlerTests()
    {
        _handler = new ScreenRecordHandler(
            _screen, _audit,
            NullLogger<ScreenRecordHandler>.Instance);
    }

    [Fact]
    public async Task Handle_ValidParams_DelegatesToScreenCapture()
    {
        var expected = ScreenRecordingResult.Create(Convert.ToBase64String([0x00]), 10000, 10.0f, 0, false).Value;
        _screen.RecordAsync(Arg.Any<ScreenRecordingParams>(), Arg.Any<CancellationToken>())
            .Returns(expected);

        var result = await _handler.Handle(
            new ScreenRecordCommand("""{"format":"mp4","durationMs":10000,"fps":10}"""), default);

        result.IsError.Should().BeFalse();
        result.Value.Should().Be(expected);
    }

    [Fact]
    public async Task Handle_InvalidFormat_ReturnsDomainError()
    {
        // "INVALID_REQUEST: screen format must be mp4" — canonical macOS error
        var result = await _handler.Handle(
            new ScreenRecordCommand("""{"format":"avi"}"""), default);

        result.IsError.Should().BeTrue();
        await _screen.DidNotReceive().RecordAsync(Arg.Any<ScreenRecordingParams>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_AuditsResult()
    {
        _screen.RecordAsync(Arg.Any<ScreenRecordingParams>(), Arg.Any<CancellationToken>())
            .Returns(ScreenRecordingResult.Create(Convert.ToBase64String([0x00]), 5000, 10.0f, 0, false).Value);

        await _handler.Handle(new ScreenRecordCommand("{}"), default);

        await _audit.Received(1).LogAsync("screen.record", "screen", true, null, Arg.Any<CancellationToken>());
    }
}
