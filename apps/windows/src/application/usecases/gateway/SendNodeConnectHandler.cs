using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Gateway;

// Sends the node.connect hello message to the gateway after WebSocket is open.
[UseCase("UC-003")]
public sealed record SendNodeConnectCommand(NodeConnectPayload Payload) : IRequest<ErrorOr<Success>>;

internal sealed class SendNodeConnectHandler : IRequestHandler<SendNodeConnectCommand, ErrorOr<Success>>
{
    private readonly IGatewayWebSocket _ws;
    private readonly ILogger<SendNodeConnectHandler> _logger;

    public SendNodeConnectHandler(IGatewayWebSocket ws, ILogger<SendNodeConnectHandler> logger)
    {
        _ws = ws;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(SendNodeConnectCommand cmd, CancellationToken ct)
    {
        Guard.Against.Null(cmd.Payload, nameof(cmd.Payload));

        var message = JsonSerializer.Serialize(new
        {
            type = "node.connect",
            payload = new
            {
                clientId = "openclaw-control-ui",
                mode = "node",
                publicKey = cmd.Payload.PublicKeyBase64,
                commands = NodeConnectPayload.DefaultCommands,
                capabilities = NodeConnectPayload.DefaultCapabilities,
                permissions = cmd.Payload.Permissions,
            }
        });

        await _ws.SendAsync(message, ct);
        _logger.LogInformation("Sent node.connect to gateway");
        return Result.Success;
    }
}
