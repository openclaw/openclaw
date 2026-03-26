using OpenClawWindows.Application.Canvas;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Tests.Unit.Application.UseCases;

public sealed class CanvasNavigateHandlerTests
{
    private readonly IWebView2Host _host = Substitute.For<IWebView2Host>();
    private readonly CanvasWindow _window = CanvasWindow.Create();
    private readonly CanvasNavigateHandler _handler;

    public CanvasNavigateHandlerTests()
    {
        _handler = new CanvasNavigateHandler(_host, _window);
    }

    [Theory]
    [InlineData("http://localhost:3000/canvas")]
    [InlineData("https://example.com/path?q=1")]
    public async Task Handle_HttpOrHttpsUrl_NavigatesAndReturnsSuccess(string url)
    {
        var result = await _handler.Handle(new CanvasNavigateCommand(url), default);

        result.IsError.Should().BeFalse();
        await _host.Received(1).NavigateAsync(url, default);
        _window.CurrentUrl.Should().Be(url);
    }

    [Theory]
    [InlineData("file:///C:/Windows/System32/drivers/etc/hosts")]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:text/html,<script>alert(1)</script>")]
    [InlineData("ftp://example.com/file")]
    public async Task Handle_NonHttpUrl_ReturnsValidationError(string url)
    {
        var result = await _handler.Handle(new CanvasNavigateCommand(url), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Type.Should().Be(ErrorType.Validation);
        await _host.DidNotReceiveWithAnyArgs().NavigateAsync(default!, default);
    }
}
