using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-008")]
public sealed record ResumeGatewayCommand : IRequest<ErrorOr<Success>>;

internal sealed class ResumeGatewayConnectionHandler : IRequestHandler<ResumeGatewayCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _socket;
    private readonly IMediator _mediator;
    private readonly ILogger<ResumeGatewayConnectionHandler> _logger;

    public ResumeGatewayConnectionHandler(IGatewayWebSocket socket, IMediator mediator,
        ILogger<ResumeGatewayConnectionHandler> logger)
    {
        _socket = socket;
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ResumeGatewayCommand cmd, CancellationToken ct)
    {
        _logger.LogInformation("Resuming gateway connection");
        await _socket.ResumeReceivingAsync(ct);
        await _mediator.Publish(new GatewayResumed(), ct);
        return Result.Success;
    }
}
