using Microsoft.Extensions.Hosting;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;

namespace OpenClawWindows.Application.Lifecycle;

[UseCase("UC-044")]
public sealed record QuitApplicationCommand(string Reason = "user_request") : IRequest<ErrorOr<Success>>;

internal sealed class QuitApplicationHandler : IRequestHandler<QuitApplicationCommand, ErrorOr<Success>>
{
    private readonly IMediator _mediator;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly ILogger<QuitApplicationHandler> _logger;

    public QuitApplicationHandler(IMediator mediator, IHostApplicationLifetime lifetime,
        ILogger<QuitApplicationHandler> logger)
    {
        _mediator = mediator;
        _lifetime = lifetime;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(QuitApplicationCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Application quit requested: reason={Reason}", cmd.Reason);

        // Graceful teardown — disconnect gateway before stopping host
        await _mediator.Send(new DisconnectFromGatewayCommand("app_quit"), ct);

        _lifetime.StopApplication();
        return Result.Success;
    }
}
