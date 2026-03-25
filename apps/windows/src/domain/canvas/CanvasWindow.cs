using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Canvas;

/// <summary>
/// WebView2-backed canvas window state
/// </summary>
public sealed class CanvasWindow : Entity<Guid>
{
    public CanvasWindowState State { get; private set; }
    public string? CurrentUrl { get; private set; }
    public bool IsPinned { get; private set; }

    private CanvasWindow()
    {
        Id = Guid.NewGuid();
        State = CanvasWindowState.Hidden;
    }

    public static CanvasWindow Create() => new();

    public void Present(string url)
    {
        Guard.Against.NullOrWhiteSpace(url, nameof(url));  // URL required when visible
        State = CanvasWindowState.Visible;
        CurrentUrl = url;
        RaiseDomainEvent(new Events.CanvasPresented { Url = url });
    }

    public void Hide()
    {
        State = CanvasWindowState.Hidden;
        RaiseDomainEvent(new Events.CanvasHidden());
    }

    public void Navigate(string url)
    {
        Guard.Against.NullOrWhiteSpace(url, nameof(url));
        CurrentUrl = url;
    }

    public void Pin() => IsPinned = true;
    public void Unpin() => IsPinned = false;
}
