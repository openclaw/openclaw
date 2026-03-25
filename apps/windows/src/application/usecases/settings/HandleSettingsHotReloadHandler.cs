using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Gateway;

namespace OpenClawWindows.Application.Settings;

[UseCase("UC-038")]
public sealed record HandleSettingsHotReloadCommand(string ChangedFilePath) : IRequest<ErrorOr<Success>>;

internal sealed class HandleSettingsHotReloadHandler
    : IRequestHandler<HandleSettingsHotReloadCommand, ErrorOr<Success>>
{
    // Debounce window matching
    private const int DebounceMs = 300;

    private DateTimeOffset _lastReload = DateTimeOffset.MinValue;
    private readonly IMediator _mediator;
    private readonly ILogger<HandleSettingsHotReloadHandler> _logger;

    public HandleSettingsHotReloadHandler(IMediator mediator, ILogger<HandleSettingsHotReloadHandler> logger)
    {
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(HandleSettingsHotReloadCommand cmd, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        if ((now - _lastReload).TotalMilliseconds < DebounceMs)
        {
            _logger.LogDebug("Settings hot-reload debounced for {Path}", cmd.ChangedFilePath);
            return Result.Success;
        }

        _lastReload = now;
        _logger.LogInformation("Settings hot-reload triggered by {Path}", cmd.ChangedFilePath);

        // Reload settings to update in-memory caches (tray menu, settings UI).
        // Do NOT apply connection mode here — LoadAsync may fetch from the gateway,
        // which doesn't carry local-only fields (connectionMode, onboardingSeen).
        // Applying gateway-sourced settings would reset connectionMode to Unconfigured
        // and kill the WebSocket connection in a reconnect loop.
        // Connection mode is applied only via SaveSettingsHandler (explicit user action)
        // or ReconnectCoordinator (startup/reconnect).
        var result = await _mediator.Send(new GetSettingsQuery(), ct);
        if (result.IsError)
            return result.Errors;

        return Result.Success;
    }
}
