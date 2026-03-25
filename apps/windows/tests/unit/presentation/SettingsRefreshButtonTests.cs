using Microsoft.UI.Xaml;
using OpenClawWindows.Presentation.Settings.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SettingsRefreshButtonTests
{
    // Mirrors SettingsRefreshButton.swift: exactly one of {spinner, button} is visible at a time.

    [Fact]
    public void SpinnerVisibility_Loading_IsVisible()
    {
        Assert.Equal(Visibility.Visible, SettingsRefreshButton.SpinnerVisibility(isLoading: true));
    }

    [Fact]
    public void SpinnerVisibility_NotLoading_IsCollapsed()
    {
        Assert.Equal(Visibility.Collapsed, SettingsRefreshButton.SpinnerVisibility(isLoading: false));
    }

    [Fact]
    public void ButtonVisibility_Loading_IsCollapsed()
    {
        // mirrors Swift: if isLoading { ProgressView() } else { Button(...) }
        Assert.Equal(Visibility.Collapsed, SettingsRefreshButton.ButtonVisibility(isLoading: true));
    }

    [Fact]
    public void ButtonVisibility_NotLoading_IsVisible()
    {
        Assert.Equal(Visibility.Visible, SettingsRefreshButton.ButtonVisibility(isLoading: false));
    }

    [Fact]
    public void SpinnerAndButton_NeverBothVisible()
    {
        foreach (var isLoading in new[] { true, false })
        {
            var spinner = SettingsRefreshButton.SpinnerVisibility(isLoading);
            var button  = SettingsRefreshButton.ButtonVisibility(isLoading);
            Assert.False(spinner == Visibility.Visible && button == Visibility.Visible,
                $"isLoading={isLoading}: both spinner and button are visible");
        }
    }
}
