using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Canvas;

namespace OpenClawWindows.Application.Canvas;

[UseCase("UC-010")]
public sealed record CanvasNavigateCommand(string Url) : IRequest<ErrorOr<Success>>;

internal sealed class CanvasNavigateHandler : IRequestHandler<CanvasNavigateCommand, ErrorOr<Success>>
{
    private readonly IWebView2Host _host;
    private readonly CanvasWindow _window;

    public CanvasNavigateHandler(IWebView2Host host, CanvasWindow window)
    {
        _host = host;
        _window = window;
    }

    public async Task<ErrorOr<Success>> Handle(CanvasNavigateCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.Url, nameof(cmd.Url));

        // Only http/https allowed — prevents a compromised gateway from navigating to file:// paths.
        if (!Uri.TryCreate(cmd.Url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != "http" && uri.Scheme != "https"))
            return Error.Validation("INVALID_URL", $"Canvas navigation only allows http and https URLs (got '{uri?.Scheme ?? cmd.Url}')");

        _window.Navigate(cmd.Url);
        await _host.NavigateAsync(cmd.Url, ct);
        return Result.Success;
    }
}
