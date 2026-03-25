using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Canvas;

[UseCase("UC-008")]
public sealed record CanvasPresentCommand(string ParamsJson) : IRequest<ErrorOr<Success>>;

internal sealed class CanvasPresentHandler : IRequestHandler<CanvasPresentCommand, ErrorOr<Success>>
{
    private readonly IWebView2Host _host;
    private readonly CanvasWindow _window;
    private readonly ILogger<CanvasPresentHandler> _logger;

    public CanvasPresentHandler(IWebView2Host host, CanvasWindow window, ILogger<CanvasPresentHandler> logger)
    {
        _host = host;
        _window = window;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(CanvasPresentCommand cmd, CancellationToken ct)
    {
        var paramsResult = CanvasPresentParams.FromJson(cmd.ParamsJson);
        if (paramsResult.IsError)
            return paramsResult.Errors;

        var p = paramsResult.Value;
        _window.Present(p.Url);

        await _host.PresentAsync(p, ct);
        _logger.LogInformation("canvas.present url={Url}", p.Url);

        return Result.Success;
    }
}
