using OpenClawWindows.Presentation.Settings.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SettingsSidebarCardTests
{
    // Mirrors settingsSidebarCardLayout() Swift extension constants.

    [Fact]
    public void MinWidth_MatchesSwift()
    {
        Assert.Equal(220.0, SettingsSidebarCard.MinWidthValue);
    }

    [Fact]
    public void IdealWidth_MatchesSwift()
    {
        Assert.Equal(240.0, SettingsSidebarCard.IdealWidth);
    }

    [Fact]
    public void MaxWidth_MatchesSwift()
    {
        Assert.Equal(280.0, SettingsSidebarCard.MaxWidthValue);
    }

    [Fact]
    public void CornerRadius_MatchesSwift()
    {
        // RoundedRectangle(cornerRadius: 12)
        Assert.Equal(12.0, SettingsSidebarCard.CornerRadiusValue);
    }
}
