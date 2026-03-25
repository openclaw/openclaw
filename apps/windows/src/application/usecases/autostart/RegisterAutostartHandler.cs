using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Application.Autostart;

[UseCase("UC-040")]
public sealed record RegisterAutostartCommand(string AppPath) : IRequest<ErrorOr<Success>>;

internal sealed class RegisterAutostartHandler : IRequestHandler<RegisterAutostartCommand, ErrorOr<Success>>
{
    private readonly ITaskScheduler _scheduler;
    private readonly ILogger<RegisterAutostartHandler> _logger;

    public RegisterAutostartHandler(ITaskScheduler scheduler, ILogger<RegisterAutostartHandler> logger)
    {
        _scheduler = scheduler;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(RegisterAutostartCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.AppPath, nameof(cmd.AppPath));

        await _scheduler.RegisterAutostartAsync(cmd.AppPath, ct);
        _logger.LogInformation("Autostart registered for {AppPath}", cmd.AppPath);
        return Result.Success;
    }
}
