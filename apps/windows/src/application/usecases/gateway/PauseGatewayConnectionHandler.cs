using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-007")]
public sealed record PauseGatewayCommand : IRequest<ErrorOr<Success>>;

internal sealed class PauseGatewayConnectionHandler : IRequestHandler<PauseGatewayCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _socket;
    private readonly IMediator _mediator;
    private readonly ILogger<PauseGatewayConnectionHandler> _logger;

    public PauseGatewayConnectionHandler(IGatewayWebSocket socket, IMediator mediator,
        ILogger<PauseGatewayConnectionHandler> logger)
    {
        _socket = socket;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(PauseGatewayCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Pausing gateway connection");
        await _socket.SuspendReceivingAsync(ct);
        await _mediator.Publish(new GatewayPaused(), ct);
        return Result.Success;
    }
}
