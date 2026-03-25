using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class MenuHeaderViewsTests
{
    // ── MenuSessionsHeaderView.Subtitle ──────────────────────────────────────

    [Fact]
    public void SessionsSubtitle_Singular_ReturnsOneSentence()
    {
        Assert.Equal("1 session · 24h", MenuSessionsHeaderView.Subtitle(1));
    }

    [Fact]
    public void SessionsSubtitle_Zero_ReturnsPlural()
    {
        Assert.Equal("0 sessions · 24h", MenuSessionsHeaderView.Subtitle(0));
    }

    [Fact]
    public void SessionsSubtitle_Plural_ReturnsCountSentence()
    {
        Assert.Equal("5 sessions · 24h", MenuSessionsHeaderView.Subtitle(5));
    }

    // ── MenuUsageHeaderView.Subtitle ─────────────────────────────────────────

    [Fact]
    public void UsageSubtitle_Singular_ReturnsOneProvider()
    {
        Assert.Equal("1 provider", MenuUsageHeaderView.Subtitle(1));
    }

    [Fact]
    public void UsageSubtitle_Zero_ReturnsPlural()
    {
        Assert.Equal("0 providers", MenuUsageHeaderView.Subtitle(0));
    }

    [Fact]
    public void UsageSubtitle_Plural_ReturnsCountProviders()
    {
        Assert.Equal("3 providers", MenuUsageHeaderView.Subtitle(3));
    }
}
