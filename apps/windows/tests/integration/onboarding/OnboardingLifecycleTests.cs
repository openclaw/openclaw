using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Autostart;
using OpenClawWindows.Application.Onboarding;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Tests.Integration.Onboarding;

// Integration: OnboardingSession domain state machine + RunOnboardingWizardHandler.
// Verifies the complete onboarding flow from Welcome → Completed, and that the
// handler skips onboarding when gateway is already configured.
public sealed class OnboardingLifecycleTests
{
    // ── OnboardingSession domain state machine ────────────────────────────────

    [Fact]
    public void Session_InitialStep_IsWelcome()
    {
        var session = OnboardingSession.Create();
        session.CurrentStep.Should().Be(OnboardingStep.Welcome);
        session.IsCompleted.Should().BeFalse();
        session.IsGatewayValidated.Should().BeFalse();
    }

    [Fact]
    public void Session_AdvanceForward_Succeeds()
    {
        var session = OnboardingSession.Create();

        var result = session.AdvanceTo(OnboardingStep.GatewaySetup);

        result.IsError.Should().BeFalse();
        session.CurrentStep.Should().Be(OnboardingStep.GatewaySetup);
    }

    [Fact]
    public void Session_StepRegression_ReturnsError()
    {
        var session = OnboardingSession.Create();
        session.AdvanceTo(OnboardingStep.GatewaySetup);
        session.AdvanceTo(OnboardingStep.PairingAuth);

        // Regression — going backwards is a protocol violation
        var result = session.AdvanceTo(OnboardingStep.GatewaySetup);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void Session_SameStep_ReturnsError()
    {
        var session = OnboardingSession.Create();

        var result = session.AdvanceTo(OnboardingStep.Welcome);

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void Session_CompleteWithoutGatewayValidation_ReturnsError()
    {
        var session = OnboardingSession.Create();
        var endpoint = GatewayEndpoint.Create("ws://localhost:18789", "Local").Value;
        session.SetGatewayEndpoint(endpoint);
        // Did not call MarkGatewayValidated

        var result = session.Complete();

        result.IsError.Should().BeTrue();
    }

    [Fact]
    public void Session_FullFlow_Welcome_To_Completed()
    {
        var session = OnboardingSession.Create();
        var endpoint = GatewayEndpoint.Create("ws://localhost:18789", "Local").Value;

        session.AdvanceTo(OnboardingStep.GatewaySetup).IsError.Should().BeFalse();
        session.SetGatewayEndpoint(endpoint);
        session.MarkGatewayValidated();
        session.AdvanceTo(OnboardingStep.PairingAuth).IsError.Should().BeFalse();
        var complete = session.Complete();

        complete.IsError.Should().BeFalse();
        session.IsCompleted.Should().BeTrue();
        session.CurrentStep.Should().Be(OnboardingStep.Completed);
    }

    [Fact]
    public void Session_MarkGatewayValidated_WithoutEndpoint_Throws()
    {
        var session = OnboardingSession.Create();

        // MarkGatewayValidated guards against null endpoint via Guard.Against.Null
        var act = () => session.MarkGatewayValidated();
        act.Should().Throw<Exception>();
    }

    [Fact]
    public void Session_MultipleInstances_AreIndependent()
    {
        var s1 = OnboardingSession.Create();
        var s2 = OnboardingSession.Create();

        s1.AdvanceTo(OnboardingStep.GatewaySetup);

        s2.CurrentStep.Should().Be(OnboardingStep.Welcome);
    }

    // ── RunOnboardingWizardHandler ────────────────────────────────────────────

    [Fact]
    public async Task WizardHandler_GatewayAlreadyConfigured_SkipsOnboarding()
    {
        var settings = Substitute.For<ISettingsRepository>();
        var configured = AppSettings.WithDefaults(@"C:\AppData\OpenClaw");
        // Simulate a configured endpoint by returning settings with a URI
        configured.SetGatewayEndpointUri("ws://localhost:18789");
        settings.LoadAsync(Arg.Any<CancellationToken>()).Returns(configured);

        var mediator = Substitute.For<IMediator>();
        var handler = new RunOnboardingWizardHandler(
            mediator, settings,
            NullLogger<RunOnboardingWizardHandler>.Instance);

        var result = await handler.Handle(new StartOnboardingCommand(), default);

        result.IsError.Should().BeFalse();
        // RegisterAutostartCommand was NOT sent since onboarding was skipped
        await mediator.DidNotReceive().Send(
            Arg.Any<RegisterAutostartCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task WizardHandler_NullGatewayEndpoint_StartsOnboardingAndRegistersAutostart()
    {
        var settings = Substitute.For<ISettingsRepository>();
        settings.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(AppSettings.WithDefaults(@"C:\AppData\OpenClaw"));

        var mediator = Substitute.For<IMediator>();
        mediator.Send(Arg.Any<RegisterAutostartCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(Result.Success));

        var handler = new RunOnboardingWizardHandler(
            mediator, settings,
            NullLogger<RunOnboardingWizardHandler>.Instance);

        var result = await handler.Handle(new StartOnboardingCommand(), default);

        result.IsError.Should().BeFalse();
        await mediator.Received(1).Send(
            Arg.Any<RegisterAutostartCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task WizardHandler_AutostartFails_StillReturnsSuccess()
    {
        var settings = Substitute.For<ISettingsRepository>();
        settings.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(AppSettings.WithDefaults(@"C:\AppData\OpenClaw"));

        var mediator = Substitute.For<IMediator>();
        mediator.Send(Arg.Any<RegisterAutostartCommand>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<ErrorOr<Success>>(
                Error.Failure("autostart.failed", "Task Scheduler unavailable")));

        var handler = new RunOnboardingWizardHandler(
            mediator, settings,
            NullLogger<RunOnboardingWizardHandler>.Instance);

        var result = await handler.Handle(new StartOnboardingCommand(), default);

        // Autostart failure is non-fatal — onboarding continues
        result.IsError.Should().BeFalse();
    }
}
