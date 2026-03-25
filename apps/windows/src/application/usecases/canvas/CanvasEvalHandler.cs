using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Canvas;

[UseCase("UC-011")]
public sealed record CanvasEvalCommand(string Script) : IRequest<ErrorOr<JavaScriptEvalResult>>;

internal sealed class CanvasEvalHandler : IRequestHandler<CanvasEvalCommand, ErrorOr<JavaScriptEvalResult>>
{
    private readonly IWebView2Host _host;

    public CanvasEvalHandler(IWebView2Host host)
    {
        _host = host;
    }

    public async Task<ErrorOr<JavaScriptEvalResult>> Handle(CanvasEvalCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.Script, nameof(cmd.Script));
        return await _host.EvalAsync(cmd.Script, ct);
    }
}
