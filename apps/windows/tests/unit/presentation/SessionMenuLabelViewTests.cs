using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SessionMenuLabelViewTests
{
    // Mirrors SessionMenuLabelView.swift: exact padding/spacing constants.

    [Fact]
    public void PaddingLeading_MatchesSwift()
    {
        Assert.Equal(22.0, SessionMenuLabelView.PaddingLeading);
    }

    [Fact]
    public void PaddingTrailing_MatchesSwift()
    {
        Assert.Equal(14.0, SessionMenuLabelView.PaddingTrailing);
    }

    [Fact]
    public void PaddingVertical_MatchesSwift()
    {
        Assert.Equal(10.0, SessionMenuLabelView.PaddingVertical);
    }

    [Fact]
    public void Spacing_MatchesSwift()
    {
        Assert.Equal(8.0, SessionMenuLabelView.Spacing);
    }
}
