using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-002")]
public sealed record DisconnectFromGatewayCommand(string Reason = "user_request") : IRequest<ErrorOr<Success>>;

internal sealed class DisconnectFromGatewayHandler : IRequestHandler<DisconnectFromGatewayCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _ws;
    private readonly GatewayConnection _connection;
    private readonly ISender _sender;
    private readonly ILogger<DisconnectFromGatewayHandler> _logger;

    public DisconnectFromGatewayHandler(IGatewayWebSocket ws, GatewayConnection connection,
        ISender sender, ILogger<DisconnectFromGatewayHandler> logger)
    {
        _ws = ws;
        _connection = connection;
        _sender = sender;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(DisconnectFromGatewayCommand cmd, CancellationToken ct)
    {
        await _ws.DisconnectAsync();
        _connection.MarkDisconnected(cmd.Reason);
        _logger.LogInformation("Gateway disconnected: {Reason}", cmd.Reason);

        await _sender.Send(new UpdateTrayMenuStateCommand("disconnected", null, null, 0, null, false), ct);

        return Result.Success;
    }
}
