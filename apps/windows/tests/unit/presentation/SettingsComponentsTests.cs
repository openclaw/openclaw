using Microsoft.UI.Xaml;
using OpenClawWindows.Presentation.Settings.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SettingsComponentsTests
{
    // Mirrors SettingsToggleRow.swift constants and conditional subtitle logic.

    [Fact]
    public void VStackSpacing_MatchesSwift()
    {
        // VStack(alignment: .leading, spacing: 6)
        Assert.Equal(6.0, SettingsToggleRow.VStackSpacing);
    }

    [Fact]
    public void SubtitleFontSize_MatchesSwift()
    {
        // .font(.footnote) → 12pt
        Assert.Equal(12.0, SettingsToggleRow.SubtitleFontSize);
    }

    [Fact]
    public void SubtitleVisibility_Null_IsCollapsed()
    {
        // Swift: if let subtitle — nil fails the binding
        Assert.Equal(Visibility.Collapsed, SettingsToggleRow.SubtitleVisibility(null));
    }

    [Fact]
    public void SubtitleVisibility_Empty_IsCollapsed()
    {
        // Swift: !subtitle.isEmpty
        Assert.Equal(Visibility.Collapsed, SettingsToggleRow.SubtitleVisibility(string.Empty));
    }

    [Fact]
    public void SubtitleVisibility_NonEmpty_IsVisible()
    {
        Assert.Equal(Visibility.Visible, SettingsToggleRow.SubtitleVisibility("some help text"));
    }

    [Fact]
    public void SubtitleVisibility_WhitespaceOnly_IsVisible()
    {
        // Swift only guards against isEmpty, not whitespace-only
        Assert.Equal(Visibility.Visible, SettingsToggleRow.SubtitleVisibility("   "));
    }
}
