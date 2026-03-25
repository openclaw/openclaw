using FluentValidation;
using FluentValidation.Results;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Behaviors;

namespace OpenClawWindows.Tests.Unit.Application.Behaviors;

public sealed class ValidationBehaviorTests
{
    // ── No validators ────────────────────────────────────────────────────────

    [Fact]
    public async Task Handle_NoValidators_CallsNext()
    {
        var behavior = new ValidationBehavior<TestCommand, string>(Enumerable.Empty<IValidator<TestCommand>>());
        var called = false;

        var result = await behavior.Handle(
            new TestCommand("value"),
            () => { called = true; return Task.FromResult("ok"); },
            default);

        called.Should().BeTrue();
        result.Should().Be("ok");
    }

    // ── Passing validator ────────────────────────────────────────────────────

    [Fact]
    public async Task Handle_ValidRequest_CallsNext()
    {
        var validators = new IValidator<TestCommand>[] { new AlwaysValidValidator() };
        var behavior = new ValidationBehavior<TestCommand, string>(validators);
        var called = false;

        await behavior.Handle(
            new TestCommand("ok"),
            () => { called = true; return Task.FromResult("done"); },
            default);

        called.Should().BeTrue();
    }

    // ── Failing validator ─────────────────────────────────────────────────────

    [Fact]
    public async Task Handle_InvalidRequest_ThrowsValidationException()
    {
        var validators = new IValidator<TestCommand>[] { new AlwaysFailValidator() };
        var behavior = new ValidationBehavior<TestCommand, string>(validators);

        var act = async () => await behavior.Handle(
            new TestCommand("bad"),
            () => Task.FromResult("never"),
            default);

        await act.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task Handle_InvalidRequest_DoesNotCallNext()
    {
        var validators = new IValidator<TestCommand>[] { new AlwaysFailValidator() };
        var behavior = new ValidationBehavior<TestCommand, string>(validators);
        var called = false;

        try
        {
            await behavior.Handle(
                new TestCommand("bad"),
                () => { called = true; return Task.FromResult("never"); },
                default);
        }
        catch (ValidationException) { }

        called.Should().BeFalse();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private sealed record TestCommand(string Value);

    private sealed class AlwaysValidValidator : AbstractValidator<TestCommand>
    {
        public AlwaysValidValidator() => RuleFor(x => x.Value).NotEmpty();
    }

    private sealed class AlwaysFailValidator : AbstractValidator<TestCommand>
    {
        public AlwaysFailValidator() => RuleFor(x => x.Value).Must(_ => false).WithMessage("always fails");
    }
}

public sealed class TraceabilityBehaviorTests
{
    [Fact]
    public async Task Handle_CallsNext_AndReturnsResult()
    {
        var behavior = new TraceabilityBehavior<TracedCommand, int>(
            NullLogger<TraceabilityBehavior<TracedCommand, int>>.Instance);

        var result = await behavior.Handle(
            new TracedCommand(),
            () => Task.FromResult(42),
            default);

        result.Should().Be(42);
    }

    [Fact]
    public async Task Handle_WithUseCaseAttribute_ReadsId()
    {
        // TraceabilityBehavior reads [UseCase("...")] from the request type.
        // Verify it doesn't throw for attributed types.
        var behavior = new TraceabilityBehavior<TracedCommand, int>(
            NullLogger<TraceabilityBehavior<TracedCommand, int>>.Instance);

        var act = async () => await behavior.Handle(new TracedCommand(), () => Task.FromResult(0), default);

        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task Handle_WithoutUseCaseAttribute_UsesUnknown()
    {
        // Without [UseCase] the behavior falls back to "unknown" — must not throw.
        var behavior = new TraceabilityBehavior<UntracedCommand, int>(
            NullLogger<TraceabilityBehavior<UntracedCommand, int>>.Instance);

        var act = async () => await behavior.Handle(new UntracedCommand(), () => Task.FromResult(0), default);

        await act.Should().NotThrowAsync();
    }

    [UseCase("UC-TEST-001")]
    private sealed record TracedCommand;

    private sealed record UntracedCommand;
}
