using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class UsageMenuLabelViewTests
{
    // Mirrors UsageMenuLabelView.swift: exact padding/spacing constants.

    [Fact]
    public void PaddingLeading_MatchesSwift()
    {
        Assert.Equal(22.0, UsageMenuLabelView.PaddingLeading);
    }

    [Fact]
    public void PaddingTrailing_MatchesSwift()
    {
        Assert.Equal(14.0, UsageMenuLabelView.PaddingTrailing);
    }

    [Fact]
    public void PaddingVertical_MatchesSwift()
    {
        Assert.Equal(10.0, UsageMenuLabelView.PaddingVertical);
    }

    [Fact]
    public void Spacing_MatchesSwift()
    {
        Assert.Equal(8.0, UsageMenuLabelView.Spacing);
    }
}
