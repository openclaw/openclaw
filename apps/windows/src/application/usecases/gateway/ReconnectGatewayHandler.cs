using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Gateway;

// Triggered by the reconnect policy (Polly) — marks connection as reconnecting before retry.
[UseCase("UC-006")]
public sealed record ReconnectGatewayCommand(GatewayEndpoint Endpoint) : IRequest<ErrorOr<Success>>;

internal sealed class ReconnectGatewayHandler : IRequestHandler<ReconnectGatewayCommand, ErrorOr<Success>>
{
    private readonly IMediator _mediator;
    private readonly GatewayConnection _connection;
    private readonly ILogger<ReconnectGatewayHandler> _logger;

    public ReconnectGatewayHandler(IMediator mediator, GatewayConnection connection,
        ILogger<ReconnectGatewayHandler> logger)
    {
        _mediator = mediator;
        _connection = connection;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ReconnectGatewayCommand cmd, CancellationToken ct)
    {
        _connection.MarkReconnecting();
        _logger.LogInformation("Gateway reconnecting to {Uri}", cmd.Endpoint.Uri);

        await _mediator.Send(new UpdateTrayMenuStateCommand("reconnecting", null, null, 0, null, false), ct);

        return await _mediator.Send(new ConnectToGatewayCommand(cmd.Endpoint), ct);
    }
}
