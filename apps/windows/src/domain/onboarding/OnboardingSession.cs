using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Onboarding;

public sealed class OnboardingSession : Entity<Guid>
{
    public OnboardingStep CurrentStep { get; private set; }
    public GatewayEndpoint? GatewayEndpoint { get; private set; }
    public bool IsGatewayValidated { get; private set; }
    public bool IsCompleted => CurrentStep == OnboardingStep.Completed;

    private OnboardingSession()
    {
        Id = Guid.NewGuid();
        CurrentStep = OnboardingStep.Welcome;
    }

    public static OnboardingSession Create() => new();

    public ErrorOr<Success> AdvanceTo(OnboardingStep step)
    {
        // steps can only advance forward — regression is a protocol violation
        if ((int)step <= (int)CurrentStep)
            return DomainErrors.Onboarding.StepRegression((int)CurrentStep, (int)step);

        CurrentStep = step;
        return Result.Success;
    }

    public void SetGatewayEndpoint(GatewayEndpoint endpoint)
    {
        Guard.Against.Null(endpoint, nameof(endpoint));
        GatewayEndpoint = endpoint;
    }

    public void MarkGatewayValidated()
    {
        Guard.Against.Null(GatewayEndpoint, nameof(GatewayEndpoint));
        IsGatewayValidated = true;
    }

    public ErrorOr<Success> Complete()
    {
        // gateway must be validated before completion
        if (!IsGatewayValidated)
            return DomainErrors.Onboarding.GatewayNotValidated();

        CurrentStep = OnboardingStep.Completed;
        return Result.Success;
    }
}
