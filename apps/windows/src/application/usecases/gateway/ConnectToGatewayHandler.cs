using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.SystemTray;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.Gateway.Events;

namespace OpenClawWindows.Application.Gateway;

[UseCase("UC-001")]
public sealed record ConnectToGatewayCommand(GatewayEndpoint Endpoint) : IRequest<ErrorOr<Success>>;

internal sealed class ConnectToGatewayHandler : IRequestHandler<ConnectToGatewayCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _ws;
    private readonly GatewayConnection _connection;
    private readonly ISender _sender;
    private readonly ILogger<ConnectToGatewayHandler> _logger;

    public ConnectToGatewayHandler(IGatewayWebSocket ws, GatewayConnection connection,
        ISender sender, ILogger<ConnectToGatewayHandler> logger)
    {
        _ws = ws;
        _connection = connection;
        _sender = sender;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(ConnectToGatewayCommand cmd, CancellationToken ct)
    {
        Guard.Against.Null(cmd.Endpoint, nameof(cmd.Endpoint));

        _connection.MarkConnecting();
        await _sender.Send(new UpdateTrayMenuStateCommand("connecting", null, null, 0, null, false), ct);

        try
        {
            await _ws.ConnectAsync(cmd.Endpoint, ct);
            _logger.LogInformation("Gateway WebSocket connected to {Uri}", cmd.Endpoint.Uri);
            return Result.Success;
        }
        catch (Exception ex)
        {
            _connection.MarkDisconnected(ex.Message);
            await _sender.Send(new UpdateTrayMenuStateCommand("disconnected", null, null, 0, null, false), ct);
            _logger.LogError(ex, "Gateway connection failed");
            return Error.Failure("GW-CONNECT", ex.Message);
        }
    }
}
