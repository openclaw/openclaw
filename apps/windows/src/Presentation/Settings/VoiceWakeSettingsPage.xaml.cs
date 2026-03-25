using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class VoiceWakeSettingsPage : Page
{
    private VoiceWakeSettingsViewModel? _vm;

    public VoiceWakeSettingsPage()
    {
        InitializeComponent();
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        _vm = e.Parameter as VoiceWakeSettingsViewModel;
        DataContext = _vm;
        if (_vm is not null)
        {
            _ = _vm.LoadCommand.ExecuteAsync(null);
            TestCard.ToggleRequested += OnTestCardToggleRequested;
        }
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        TestCard.ToggleRequested -= OnTestCardToggleRequested;
        _vm?.StopTest();
    }

    private void OnTestCardToggleRequested(object sender, RoutedEventArgs e)
        => _vm?.ToggleTestCommand.Execute(null);

    // The RemoveTriggerWord command needs the word string as parameter.
    // DataTemplate binding passes the word via Button.Tag.
    private void OnRemoveTriggerWordClicked(object sender, RoutedEventArgs e)
    {
        if (_vm is null) return;
        if (sender is FrameworkElement { Tag: string word })
            _vm.RemoveTriggerWordCommand.Execute(word);
    }
}
