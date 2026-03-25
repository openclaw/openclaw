using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Canvas.Events;

public sealed record CanvasPresented : DomainEvent
{
    public required string Url { get; init; }
}
