using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class TailscaleSettingsSection : UserControl
{
    private TailscaleSettingsViewModel? _vm;
    private DispatcherTimer? _statusTimer;

    public TailscaleSettingsSection()
    {
        InitializeComponent();
        Unloaded += OnUnloaded;
    }

    public void Bind(TailscaleSettingsViewModel vm)
    {
        _vm = vm;
        DataContext = vm;
        _ = vm.LoadCommand.ExecuteAsync(null);
        StartStatusTimer();
    }

    private void StartStatusTimer()
    {
        _statusTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _statusTimer.Tick += (_, _) => _vm?.CheckStatusCommand.Execute(null);
        _statusTimer.Start();
    }

    private void OnUnloaded(object sender, RoutedEventArgs e)
    {
        _statusTimer?.Stop();
        _statusTimer = null;
    }
}
