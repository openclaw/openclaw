using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Canvas;

[UseCase("UC-009")]
public sealed record CanvasHideCommand : IRequest<ErrorOr<Success>>;

internal sealed class CanvasHideHandler : IRequestHandler<CanvasHideCommand, ErrorOr<Success>>
{
    private readonly IWebView2Host _host;
    private readonly CanvasWindow _window;

    public CanvasHideHandler(IWebView2Host host, CanvasWindow window)
    {
        _host = host;
        _window = window;
    }

    public async Task<ErrorOr<Success>> Handle(CanvasHideCommand _, CancellationToken ct)
    {
        _window.Hide();
        await _host.HideAsync(ct);
        return Result.Success;
    }
}
