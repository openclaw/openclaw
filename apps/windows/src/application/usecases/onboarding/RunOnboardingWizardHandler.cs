using OpenClawWindows.Application.Autostart;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Application.Onboarding;

[UseCase("UC-039")]
public sealed record StartOnboardingCommand : IRequest<ErrorOr<Success>>;

internal sealed class RunOnboardingWizardHandler : IRequestHandler<StartOnboardingCommand, ErrorOr<Success>>
{
    private readonly IMediator _mediator;
    private readonly ISettingsRepository _settings;
    private readonly ILogger<RunOnboardingWizardHandler> _logger;

    public RunOnboardingWizardHandler(IMediator mediator, ISettingsRepository settings,
        ILogger<RunOnboardingWizardHandler> logger)
    {
        _mediator = mediator;
        _settings = settings;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> Handle(StartOnboardingCommand cmd, CancellationToken ct)
    {
        var existing = await _settings.LoadAsync(ct);
        if (existing.GatewayEndpoint is not null)
        {
            _logger.LogDebug("Onboarding skipped — gateway already configured");
            return Result.Success;
        }

        _logger.LogInformation("Starting onboarding wizard");

        // Presentation layer shows the WelcomeWindow and drives the wizard flow.
        // Application layer completes gateway setup and autostart registration.
        var appPath = Environment.ProcessPath ?? "openclaw";
        var registerResult = await _mediator.Send(new RegisterAutostartCommand(appPath), ct);
        if (registerResult.IsError)
            _logger.LogWarning("Autostart registration failed during onboarding: {Error}",
                registerResult.FirstError.Description);

        return Result.Success;
    }
}
