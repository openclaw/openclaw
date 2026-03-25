namespace OpenClawWindows.Domain.WorkActivity;

// Discriminated union mirroring IconState enum.
internal abstract record IconState
{
    internal sealed record Idle : IconState;
    internal sealed record WorkingMain(ActivityKind Kind) : IconState;
    internal sealed record WorkingOther(ActivityKind Kind) : IconState;
    internal sealed record Overridden(ActivityKind Kind) : IconState;

    internal bool IsWorking => this is not Idle;

    // "Prominence" avoids shadowing the BadgeProminence type name in the same namespace.
    internal BadgeProminence? Prominence => this switch
    {
        Idle         => null,
        WorkingMain  => BadgeProminence.Primary,
        WorkingOther => BadgeProminence.Secondary,
        Overridden   => BadgeProminence.Overridden,
        _            => null,
    };
}

internal enum BadgeProminence { Primary, Secondary, Overridden }
