using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Canvas;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class CanvasPresentHandlerTests
{
    private readonly IWebView2Host _host = Substitute.For<IWebView2Host>();
    private readonly CanvasWindow _window = CanvasWindow.Create();
    private readonly CanvasPresentHandler _handler;

    public CanvasPresentHandlerTests()
    {
        _handler = new CanvasPresentHandler(_host, _window,
            NullLogger<CanvasPresentHandler>.Instance);

        _host.PresentAsync(Arg.Any<CanvasPresentParams>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
    }

    [Fact]
    public async Task Handle_ValidParams_CallsHostPresent()
    {
        var result = await _handler.Handle(
            new CanvasPresentCommand("""{"url":"https://canvas.local/app"}"""), default);

        result.IsError.Should().BeFalse();
        await _host.Received(1).PresentAsync(
            Arg.Is<CanvasPresentParams>(p => p.Url == "https://canvas.local/app"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Handle_ValidParams_UpdatesWindowState()
    {
        await _handler.Handle(
            new CanvasPresentCommand("""{"url":"https://canvas.local/app"}"""), default);

        _window.State.Should().Be(CanvasWindowState.Visible);
        _window.CurrentUrl.Should().Be("https://canvas.local/app");
    }

    [Fact]
    public async Task Handle_MissingUrl_ReturnsError()
    {
        var result = await _handler.Handle(
            new CanvasPresentCommand("""{"pin":true}"""), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("CVS-PARSE");
    }

    [Fact]
    public async Task Handle_InvalidJson_ReturnsError()
    {
        var result = await _handler.Handle(
            new CanvasPresentCommand("not-json"), default);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public async Task Handle_MissingUrl_DoesNotCallHost()
    {
        await _handler.Handle(new CanvasPresentCommand("{}"), default);

        await _host.DidNotReceive().PresentAsync(Arg.Any<CanvasPresentParams>(), Arg.Any<CancellationToken>());
    }
}

public sealed class CanvasPresentParamsTests
{
    [Fact]
    public void FromJson_ValidUrl_ReturnsParams()
    {
        var result = CanvasPresentParams.FromJson("""{"url":"https://host/path"}""");
        result.IsError.Should().BeFalse();
        result.Value.Url.Should().Be("https://host/path");
        result.Value.Pin.Should().BeFalse();
    }

    [Fact]
    public void FromJson_WithPin_ParsesPin()
    {
        var result = CanvasPresentParams.FromJson("""{"url":"https://host","pin":true}""");
        result.IsError.Should().BeFalse();
        result.Value.Pin.Should().BeTrue();
    }

    [Fact]
    public void FromJson_MissingUrl_ReturnsError()
    {
        var result = CanvasPresentParams.FromJson("""{"pin":false}""");
        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("CVS-PARSE");
    }

    [Fact]
    public void FromJson_EmptyUrl_ReturnsError()
    {
        var result = CanvasPresentParams.FromJson("""{"url":"   "}""");
        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void FromJson_InvalidJson_ReturnsError()
    {
        var result = CanvasPresentParams.FromJson("{broken");
        result.IsError.Should().BeTrue();
    }
}
