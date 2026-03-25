namespace OpenClawWindows.Tests.Unit.Domain.Canvas;

public sealed class CanvasWindowTests
{
    [Fact]
    public void Create_InitialState_IsHidden()
    {
        var win = CanvasWindow.Create();

        win.State.Should().Be(CanvasWindowState.Hidden);
        win.CurrentUrl.Should().BeNull();
        win.IsPinned.Should().BeFalse();
    }

    [Fact]
    public void Present_ValidUrl_BecomesVisible()
    {
        var win = CanvasWindow.Create();

        win.Present("https://canvas.host/app");

        win.State.Should().Be(CanvasWindowState.Visible);
        win.CurrentUrl.Should().Be("https://canvas.host/app");
    }

    [Fact]
    public void Present_EmptyUrl_Throws()
    {
        var win = CanvasWindow.Create();

        var act = () => win.Present("");

        act.Should().Throw<Exception>();
    }

    [Fact]
    public void Present_RaisesCanvasPresentedEvent()
    {
        var win = CanvasWindow.Create();

        win.Present("https://host");

        win.DomainEvents.OfType<OpenClawWindows.Domain.Canvas.Events.CanvasPresented>()
            .Should().ContainSingle(e => e.Url == "https://host");
    }

    [Fact]
    public void Hide_FromVisible_BecomesHidden()
    {
        var win = CanvasWindow.Create();
        win.Present("https://host");

        win.Hide();

        win.State.Should().Be(CanvasWindowState.Hidden);
    }

    [Fact]
    public void Hide_RaisesCanvasHiddenEvent()
    {
        var win = CanvasWindow.Create();
        win.Present("https://host");
        win.ClearDomainEvents();

        win.Hide();

        win.DomainEvents.OfType<OpenClawWindows.Domain.Canvas.Events.CanvasHidden>()
            .Should().ContainSingle();
    }

    [Fact]
    public void Navigate_UpdatesUrl()
    {
        var win = CanvasWindow.Create();
        win.Present("https://initial");

        win.Navigate("https://updated");

        win.CurrentUrl.Should().Be("https://updated");
    }

    [Fact]
    public void Pin_SetsIsPinnedTrue()
    {
        var win = CanvasWindow.Create();

        win.Pin();

        win.IsPinned.Should().BeTrue();
    }

    [Fact]
    public void Unpin_ClearsIsPinned()
    {
        var win = CanvasWindow.Create();
        win.Pin();

        win.Unpin();

        win.IsPinned.Should().BeFalse();
    }
}
