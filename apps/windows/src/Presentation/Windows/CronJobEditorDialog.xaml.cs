using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class CronJobEditorDialog : ContentDialog
{
    private readonly CronJobEditorViewModel _vm;

    // Non-null when Primary button accepted; null when cancelled.
    public Dictionary<string, object?>? Result { get; private set; }

    public CronJobEditorDialog(CronJobEditorViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        DataContext = vm;
        Title = vm.Title;

        // Hydrate channel ComboBox from ViewModel (WinUI 3 lacks SelectedValuePath for complex objects).
        RefreshChannelOptions();

        // Validate + build payload without auto-closing on error.
        PrimaryButtonClick += OnSaveClicked;
    }

    private void RefreshChannelOptions()
    {
        var options = _vm.ChannelOptions;
        ChannelComboBox.ItemsSource = options.Select(o => o.Label).ToList();

        var idx = options.FindIndex(o => o.Id == _vm.Channel);
        ChannelComboBox.SelectedIndex = idx >= 0 ? idx : 0;

        ChannelComboBox.SelectionChanged += (_, _) =>
        {
            var sel = ChannelComboBox.SelectedIndex;
            if (sel >= 0 && sel < options.Count)
                _vm.Channel = options[sel].Id;
        };
    }

    private void OnSaveClicked(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        // Prevent ContentDialog from closing; close manually only on success.
        args.Cancel = true;

        _vm.Error = null;
        try
        {
            Result = _vm.BuildPayload();
            // Payload is valid — close the dialog.
            Hide();
        }
        catch (InvalidOperationException ex)
        {
            _vm.Error = ex.Message;
        }
    }
}
