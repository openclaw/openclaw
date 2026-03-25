using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Gateway;

// Handles the hello-ok response from the gateway — extracts sessionKey and canvasHostUrl.
[UseCase("UC-004")]
public sealed record ProcessHelloOkCommand(string SessionKey, string? CanvasHostUrl) : IRequest<ErrorOr<Success>>;

internal sealed class ProcessHelloOkHandler : IRequestHandler<ProcessHelloOkCommand, ErrorOr<Success>>
{
    private readonly GatewayConnection _connection;
    private readonly TimeProvider _timeProvider;
    private readonly ILogger<ProcessHelloOkHandler> _logger;

    public ProcessHelloOkHandler(GatewayConnection connection, TimeProvider timeProvider,
        ILogger<ProcessHelloOkHandler> logger)
    {
        _connection = connection;
        _timeProvider = timeProvider;
        _logger = logger;
    }

    public Task<ErrorOr<Success>> Handle(ProcessHelloOkCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.SessionKey, nameof(cmd.SessionKey));

        _connection.MarkConnected(cmd.SessionKey, cmd.CanvasHostUrl, _timeProvider);
        _logger.LogInformation("Gateway hello-ok received, session established");

        return Task.FromResult<ErrorOr<Success>>(Result.Success);
    }
}
