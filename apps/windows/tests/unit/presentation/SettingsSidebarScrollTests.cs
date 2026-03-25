using OpenClawWindows.Presentation.Settings.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SettingsSidebarScrollTests
{
    // Mirrors SettingsSidebarScroll.swift constants.

    [Fact]
    public void ContentPadding_MatchesSwift()
    {
        // .padding(.vertical, 10) + .padding(.horizontal, 10)
        Assert.Equal(10.0, SettingsSidebarScroll.ContentPadding);
    }

    [Fact]
    public void MinWidth_MatchesSettingsSidebarCardLayout()
    {
        Assert.Equal(220.0, SettingsSidebarScroll.MinWidthValue);
    }

    [Fact]
    public void IdealWidth_MatchesSettingsSidebarCardLayout()
    {
        Assert.Equal(240.0, SettingsSidebarScroll.IdealWidth);
    }

    [Fact]
    public void MaxWidth_MatchesSettingsSidebarCardLayout()
    {
        Assert.Equal(280.0, SettingsSidebarScroll.MaxWidthValue);
    }

    [Fact]
    public void CornerRadius_MatchesSettingsSidebarCardLayout()
    {
        // RoundedRectangle(cornerRadius: 12)
        Assert.Equal(12.0, SettingsSidebarScroll.CornerRadiusValue);
    }
}
