using System.Collections.Specialized;
using System.ComponentModel;
using Microsoft.UI;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Domain.ExecApprovals;
using OpenClawWindows.Presentation.ViewModels;
using WinUIApplication = Microsoft.UI.Xaml.Application;

namespace OpenClawWindows.Presentation.Settings;

/// <summary>
/// Exec approvals policy and allowlist editor.
/// programmatic UIElement tree replaces SwiftUI's declarative VStack/Picker/Toggle.
/// </summary>
internal sealed partial class SystemRunSettingsPage : Page
{
    private SystemRunSettingsViewModel? _vm;
    private bool _showAllowlist; // false → policy tab (Access), true → allowlist tab
    private string _newPatternDraft = ""; // preserves add-entry text across Rebuild()

    public SystemRunSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _vm = e.Parameter as SystemRunSettingsViewModel;
        if (_vm is null) return;
        _vm.PropertyChanged      += OnVmPropertyChanged;
        _vm.Entries.CollectionChanged += OnEntriesChanged;
        _ = InitAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        if (_vm is null) return;
        _vm.PropertyChanged           -= OnVmPropertyChanged;
        _vm.Entries.CollectionChanged -= OnEntriesChanged;
    }

    private async Task InitAsync()
    {
        if (_vm is null) return;
        await _vm.RefreshAsync();
        Rebuild();
    }

    private void OnVmPropertyChanged(object? sender, PropertyChangedEventArgs e) =>
        DispatcherQueue.TryEnqueue(Rebuild);

    private void OnEntriesChanged(object? sender, NotifyCollectionChangedEventArgs e) =>
        DispatcherQueue.TryEnqueue(Rebuild);

    // ── Panel builder ─────────────────────────────────────────────────────────

    private void Rebuild()
    {
        if (_vm is null) return;
        RootPanel.Children.Clear();

        if (_vm.IsLoading)
        {
            RootPanel.Children.Add(new ProgressRing { IsActive = true, Width = 20, Height = 20 });
            return;
        }

        RootPanel.Children.Add(BuildHeaderRow());
        RootPanel.Children.Add(BuildTabBar());
        RootPanel.Children.Add(_showAllowlist ? BuildAllowlistPanel() : BuildPolicyPanel());
    }

    private UIElement BuildHeaderRow()
    {
        var label = new TextBlock
        {
            Text = "Exec approvals",
            FontSize = 14,
            VerticalAlignment = VerticalAlignment.Center
        };

        var agentCombo = new ComboBox
        {
            ItemsSource  = _vm!.AgentPickerIds,
            SelectedItem = _vm.SelectedAgentId,
            Width        = 180
        };
        agentCombo.SelectionChanged += async (_, _) =>
        {
            if (agentCombo.SelectedItem is string id && _vm is not null && id != _vm.SelectedAgentId)
                await _vm.SelectAgentAsync(id);
        };

        var grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(label,      0);
        Grid.SetColumn(agentCombo, 1);
        grid.Children.Add(label);
        grid.Children.Add(agentCombo);
        return grid;
    }

    // two-button segmented tab bar
    private UIElement BuildTabBar()
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 0 };
        row.Children.Add(BuildTabButton("Access",    !_showAllowlist, () => { _showAllowlist = false; Rebuild(); }));
        row.Children.Add(BuildTabButton("Allowlist",  _showAllowlist, () => { _showAllowlist = true;  Rebuild(); }));
        return row;
    }

    private static UIElement BuildTabButton(string title, bool selected, Action onTap)
    {
        var btn = new Button
        {
            Content = title,
            Style   = selected
                ? (Style)WinUIApplication.Current.Resources["AccentButtonStyle"]
                : (Style)WinUIApplication.Current.Resources["DefaultButtonStyle"]
        };
        btn.Click += (_, _) => onTap();
        return btn;
    }

    // three pickers + scope message
    private UIElement BuildPolicyPanel()
    {
        var panel = new StackPanel { Spacing = 8 };

        var allSecurity = new[] { ExecSecurity.Deny, ExecSecurity.Allowlist, ExecSecurity.Full };
        var allAsk      = new[] { ExecAsk.Off, ExecAsk.OnMiss, ExecAsk.Always };

        // Security picker
        var secLabels = allSecurity.Select(SecurityTitle).ToList();
        var secCombo  = new ComboBox { ItemsSource = secLabels, SelectedIndex = Array.IndexOf(allSecurity, _vm!.Security) };
        secCombo.SelectionChanged += async (_, _) =>
        {
            if (_vm is null || secCombo.SelectedIndex < 0 || secCombo.SelectedIndex >= allSecurity.Length) return;
            await _vm.SetSecurityAsync(allSecurity[secCombo.SelectedIndex]);
        };
        panel.Children.Add(secCombo);

        // Ask picker
        var askLabels = allAsk.Select(AskTitle).ToList();
        var askCombo  = new ComboBox { ItemsSource = askLabels, SelectedIndex = Array.IndexOf(allAsk, _vm.Ask) };
        askCombo.SelectionChanged += async (_, _) =>
        {
            if (_vm is null || askCombo.SelectedIndex < 0 || askCombo.SelectedIndex >= allAsk.Length) return;
            await _vm.SetAskAsync(allAsk[askCombo.SelectedIndex]);
        };
        panel.Children.Add(askCombo);

        // AskFallback picker
        var fallbackLabels = allSecurity.Select(s => $"Fallback: {SecurityTitle(s)}").ToList();
        var fallbackCombo  = new ComboBox { ItemsSource = fallbackLabels, SelectedIndex = Array.IndexOf(allSecurity, _vm.AskFallback) };
        fallbackCombo.SelectionChanged += async (_, _) =>
        {
            if (_vm is null || fallbackCombo.SelectedIndex < 0 || fallbackCombo.SelectedIndex >= allSecurity.Length) return;
            await _vm.SetAskFallbackAsync(allSecurity[fallbackCombo.SelectedIndex]);
        };
        panel.Children.Add(fallbackCombo);

        panel.Children.Add(new TextBlock
        {
            Text         = _vm.ScopeMessage,
            FontSize     = 12,
            Foreground   = ResourceBrush("TextFillColorTertiaryBrush"),
            TextWrapping = TextWrapping.Wrap
        });
        return panel;
    }

    private UIElement BuildAllowlistPanel()
    {
        var panel = new StackPanel { Spacing = 10 };

        // Toggle: auto-allow skill CLIs
        var toggle = new ToggleSwitch
        {
            IsOn       = _vm!.AutoAllowSkills,
            OnContent  = "Auto-allow skill CLIs",
            OffContent = "Auto-allow skill CLIs"
        };
        toggle.Toggled += async (_, _) =>
        {
            if (_vm is not null)
                await _vm.SetAutoAllowSkillsAsync(toggle.IsOn);
        };
        panel.Children.Add(toggle);

        // Skill bins hint
        if (_vm.AutoAllowSkills && _vm.SkillBins.Count > 0)
        {
            panel.Children.Add(new TextBlock
            {
                Text       = $"Skill CLIs: {string.Join(", ", _vm.SkillBins)}",
                FontSize   = 12,
                Foreground = ResourceBrush("TextFillColorSecondaryBrush")
            });
        }

        if (_vm.IsDefaultsScope)
        {
            panel.Children.Add(new TextBlock
            {
                Text         = "Allowlists are per-agent. Select an agent to edit its allowlist.",
                FontSize     = 12,
                Foreground   = ResourceBrush("TextFillColorSecondaryBrush"),
                TextWrapping = TextWrapping.Wrap
            });
            return panel;
        }

        // Add entry row
        var patternBox = new TextBox
        {
            Text              = _newPatternDraft,
            PlaceholderText   = "Add allowlist path pattern (case-insensitive globs)",
            HorizontalAlignment = HorizontalAlignment.Stretch
        };
        var addBtn = new Button
        {
            Content   = "Add",
            IsEnabled = _vm.IsPathPattern(_newPatternDraft)
        };
        patternBox.TextChanged += (_, _) =>
        {
            _newPatternDraft  = patternBox.Text;
            addBtn.IsEnabled  = _vm?.IsPathPattern(patternBox.Text) == true;
        };
        addBtn.Click += async (_, _) =>
        {
            if (_vm is null) return;
            if (await _vm.AddEntryAsync(patternBox.Text) is null)
            {
                _newPatternDraft = "";
                patternBox.Text  = "";
            }
        };

        var addGrid = new Grid { Margin = new Thickness(0, 0, 0, 0) };
        addGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        addGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(patternBox, 0);
        Grid.SetColumn(addBtn,     1);
        addGrid.Children.Add(patternBox);
        addGrid.Children.Add(addBtn);
        panel.Children.Add(addGrid);

        panel.Children.Add(new TextBlock
        {
            Text         = "Path patterns only. Basename entries like \"echo\" are ignored.",
            FontSize     = 12,
            Foreground   = ResourceBrush("TextFillColorSecondaryBrush"),
            TextWrapping = TextWrapping.Wrap
        });

        if (_vm.AllowlistValidationMessage is { } msg)
        {
            panel.Children.Add(new TextBlock
            {
                Text         = msg,
                FontSize     = 12,
                Foreground   = ResourceBrush("SystemFillColorCautionBrush"),
                TextWrapping = TextWrapping.Wrap
            });
        }

        if (_vm.Entries.Count == 0)
        {
            panel.Children.Add(new TextBlock
            {
                Text       = "No allowlisted commands yet.",
                FontSize   = 12,
                Foreground = ResourceBrush("TextFillColorSecondaryBrush")
            });
        }
        else
        {
            var list = new StackPanel { Spacing = 8 };
            foreach (var entry in _vm.Entries)
                list.Children.Add(BuildEntryRow(entry));
            panel.Children.Add(list);
        }

        return panel;
    }

    private UIElement BuildEntryRow(SystemRunSettingsViewModel.AllowlistEntryRow entry)
    {
        var panel = new StackPanel { Spacing = 4 };

        var patternBox = new TextBox { Text = entry.Pattern, HorizontalAlignment = HorizontalAlignment.Stretch };
        patternBox.LostFocus += async (_, _) =>
        {
            var trimmed = patternBox.Text.Trim();
            if (_vm is not null && trimmed != entry.Pattern)
                await _vm.UpdateEntryAsync(entry.Id, trimmed);
        };

        var removeBtn = new Button
        {
            Content = new FontIcon { Glyph = "\uE74D", FontSize = 14 },
            Padding = new Thickness(8, 4, 8, 4)
        };
        removeBtn.Click += async (_, _) =>
        {
            if (_vm is not null)
                await _vm.RemoveEntryAsync(entry.Id);
        };

        var topGrid = new Grid();
        topGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        topGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(patternBox, 0);
        Grid.SetColumn(removeBtn,  1);
        topGrid.Children.Add(patternBox);
        topGrid.Children.Add(removeBtn);
        panel.Children.Add(topGrid);

        // Metadata
        if (entry.LastUsedAt is { } ts)
        {
            var date = DateTimeOffset.FromUnixTimeMilliseconds((long)ts);
            panel.Children.Add(new TextBlock
            {
                Text       = $"Last used {date.LocalDateTime:g}",
                FontSize   = 11,
                Foreground = ResourceBrush("TextFillColorSecondaryBrush")
            });
        }
        if (entry.LastUsedCommand is { Length: > 0 } cmd)
        {
            panel.Children.Add(new TextBlock
            {
                Text       = $"Last command: {cmd}",
                FontSize   = 11,
                Foreground = ResourceBrush("TextFillColorSecondaryBrush")
            });
        }
        if (entry.LastResolvedPath is { Length: > 0 } rp)
        {
            panel.Children.Add(new TextBlock
            {
                Text       = $"Resolved path: {rp}",
                FontSize   = 11,
                Foreground = ResourceBrush("TextFillColorSecondaryBrush")
            });
        }

        return panel;
    }

    // ── Enum display helpers

    private static string SecurityTitle(ExecSecurity s) => s switch
    {
        ExecSecurity.Deny      => "Deny",
        ExecSecurity.Allowlist => "Allowlist",
        ExecSecurity.Full      => "Full",
        _                      => s.ToString()
    };

    private static string AskTitle(ExecAsk a) => a switch
    {
        ExecAsk.Off    => "Off",
        ExecAsk.OnMiss => "On Miss",
        ExecAsk.Always => "Always",
        _              => a.ToString()
    };

    private static Brush ResourceBrush(string key)
    {
        try { return (Brush)WinUIApplication.Current.Resources[key]; }
        catch { return new SolidColorBrush(Colors.Gray); }
    }
}
