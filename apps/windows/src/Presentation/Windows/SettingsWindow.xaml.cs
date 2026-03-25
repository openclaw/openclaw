using System.ComponentModel;
using OpenClawWindows.Presentation.Settings;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class SettingsWindow : Window
{
    private readonly SettingsViewModel _vm;

    // Window dimensions (824×790)
    private const int WindowWidth  = 824;
    private const int WindowHeight = 790;

    public SettingsWindow(SettingsViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;

        Title = "OpenClaw Settings";
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "openclaw.ico"));
        AppWindow.Resize(new global::Windows.Graphics.SizeInt32(WindowWidth, WindowHeight));

        // Keep the Debug tab visibility in sync when General settings are saved.
        _vm.General.PropertyChanged += OnGeneralSettingsChanged;

        // Navigate to General on open
        NavView.SelectedItem = NavView.MenuItems.OfType<NavigationViewItem>().First();
        ContentFrame.Navigate(typeof(GeneralSettingsPage), vm.General);
    }

    private void NavView_SelectionChanged(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.SelectedItem is not NavigationViewItem item) return;

        var tag = item.Tag?.ToString();
        Type? pageType = tag switch
        {
            "General"     => typeof(GeneralSettingsPage),
            "Channels"    => typeof(ChannelsSettingsPage),
            "Sessions"    => typeof(SessionsSettingsPage),
            "Permissions" => typeof(PermissionsSettingsPage),
            "VoiceWake"   => typeof(VoiceWakeSettingsPage),
            "Config"      => typeof(ConfigSettingsPage),
            "SystemRun"   => typeof(SystemRunSettingsPage),
            "Skills"      => typeof(SkillsSettingsPage),
            "Instances"   => typeof(InstancesSettingsPage),
            "Cron"        => typeof(CronSettingsPage),
            "Debug"       => typeof(DebugSettingsPage),
            "About"       => typeof(AboutSettingsPage),
            _             => null,
        };

        if (pageType is null) return;

        object? parameter = tag switch
        {
            "General"     => _vm.General,
            "Channels"    => _vm.Channels,
            "Sessions"    => _vm.Sessions,
            "Permissions" => _vm.Permissions,
            "VoiceWake"   => _vm.VoiceWake,
            "Config"      => _vm.Config,
            "SystemRun"   => _vm.SystemRun,
            "Skills"      => _vm.Skills,
            "Instances"   => _vm.Instances,
            "Cron"        => _vm.Cron,
            "Debug"       => _vm.Debug,
            "About"       => _vm.About,
            _             => null,
        };

        ContentFrame.Navigate(pageType, parameter);
    }

    private void OnGeneralSettingsChanged(object? sender, PropertyChangedEventArgs e)
    {
        // Propagate DebugPaneEnabled to SettingsViewModel so the Debug nav item
        // appears/disappears without requiring a restart.
        if (e.PropertyName == nameof(GeneralSettingsViewModel.DebugPaneEnabled))
            _vm.DebugPaneEnabled = _vm.General.DebugPaneEnabled;
    }
}
