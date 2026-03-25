using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Canvas;

[UseCase("UC-012")]
public sealed record CanvasSnapshotQuery : IRequest<ErrorOr<CanvasSnapshot>>;

internal sealed class CanvasSnapshotHandler : IRequestHandler<CanvasSnapshotQuery, ErrorOr<CanvasSnapshot>>
{
    private readonly IWebView2Host _host;

    public CanvasSnapshotHandler(IWebView2Host host)
    {
        _host = host;
    }

    public async Task<ErrorOr<CanvasSnapshot>> Handle(CanvasSnapshotQuery _, CancellationToken ct) =>
        await _host.SnapshotAsync(ct);
}
