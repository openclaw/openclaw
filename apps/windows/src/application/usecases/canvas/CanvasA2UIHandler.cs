using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Canvas;

[UseCase("UC-013")]
public sealed record CanvasA2UICommand(string ActionJson) : IRequest<ErrorOr<Success>>;

internal sealed class CanvasA2UIHandler : IRequestHandler<CanvasA2UICommand, ErrorOr<Success>>
{
    private readonly IWebView2Host _host;

    public CanvasA2UIHandler(IWebView2Host host)
    {
        _host = host;
    }

    public async Task<ErrorOr<Success>> Handle(CanvasA2UICommand cmd, CancellationToken ct)
    {
        var actionResult = A2UIAction.FromJson(cmd.ActionJson);
        if (actionResult.IsError)
            return actionResult.Errors;

        await _host.HandleA2UIActionAsync(actionResult.Value, ct);
        return Result.Success;
    }
}
