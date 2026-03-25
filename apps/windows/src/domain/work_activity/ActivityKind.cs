namespace OpenClawWindows.Domain.WorkActivity;

// Discriminated union mirroring ActivityKind enum.
internal abstract record ActivityKind
{
    internal sealed record Job : ActivityKind;
    internal sealed record Tool(ToolKind Kind) : ActivityKind;
}
