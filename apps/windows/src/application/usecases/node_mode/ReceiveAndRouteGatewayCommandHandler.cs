using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;

namespace OpenClawWindows.Application.NodeMode;

// Parses the raw WebSocket envelope from the gateway and routes to NodeInvokeDispatcher.
[UseCase("UC-009")]
public sealed record ReceiveGatewayCommandCommand(string RawJson) : IRequest<ErrorOr<string>>;

internal sealed class ReceiveAndRouteGatewayCommandHandler
    : IRequestHandler<ReceiveGatewayCommandCommand, ErrorOr<string>>
{
    private readonly IMediator _mediator;
    private readonly IGatewayWebSocket _socket;
    private readonly ILogger<ReceiveAndRouteGatewayCommandHandler> _logger;

    public ReceiveAndRouteGatewayCommandHandler(IMediator mediator, IGatewayWebSocket socket,
        ILogger<ReceiveAndRouteGatewayCommandHandler> logger)
    {
        _mediator = mediator;
        _socket = socket;
        _logger = logger;
    }

    public async Task<ErrorOr<string>> Handle(ReceiveGatewayCommandCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.RawJson, nameof(cmd.RawJson));

        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(cmd.RawJson);
            root = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to deserialize gateway message");
            return Error.Failure("NM.DESERIALIZE_FAILED", ex.Message);
        }

        if (!root.TryGetProperty("type", out var typeProp) || typeProp.GetString() != "node.invoke")
        {
            var msgType = root.TryGetProperty("type", out var t) ? t.GetString() : "<unknown>";
            _logger.LogDebug("Ignoring non-invoke message type={Type}", msgType);
            return "{}";
        }

        var id = root.TryGetProperty("id", out var idProp) ? idProp.GetString() ?? "" : "";
        var command = root.TryGetProperty("command", out var cmdProp) ? cmdProp.GetString() ?? "" : "";
        var paramsJson = root.TryGetProperty("params", out var paramsProp)
            ? paramsProp.GetRawText()
            : "{}";

        var request = new NodeInvokeRequest(id, command, paramsJson);
        var response = await _mediator.Send(new DispatchNodeInvokeCommand(request), ct);

        var responseJson = JsonSerializer.Serialize(new
        {
            type = "node.invoke.response",
            id = response.Id,
            ok = response.Ok,
            payload = response.PayloadJson != null ? JsonDocument.Parse(response.PayloadJson).RootElement : (JsonElement?)null,
            error = response.Error
        });

        await _socket.SendAsync(responseJson, ct);
        return responseJson;
    }
}
