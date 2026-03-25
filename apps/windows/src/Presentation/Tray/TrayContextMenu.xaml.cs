using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Presentation.Tray;

internal sealed partial class TrayContextMenu : UserControl
{
    public TrayContextMenu()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
        // Apply icon visual states after template is applied.
        // MenuFlyoutPresenter normally does this; we replicate it here since
        // our items are outside a real MenuFlyout popup.
        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        ApplyToggleIconState(SendHeartbeatsToggle);
        ApplyToggleIconState(BrowserControlToggle);
        ApplyToggleIconState(AllowCameraToggle);
        ApplyToggleIconState(AllowCanvasToggle);
        ApplyToggleIconState(VoiceWakeToggle);
        ApplyCheckAndIconPlaceholderState(ExecApprovalSubItem);
        ApplyIconPlaceholderState(OpenDashboardItem);
        ApplyIconPlaceholderState(OpenChatItem);
        ApplyIconPlaceholderState(OpenCanvasItem);
        ApplyIconPlaceholderState(TalkModeItem);
    }

    // Re-applies after every layout pass — MenuFlyoutPresenter resets states during measure/arrange.
    // GoToState is idempotent: if the state hasn't changed it returns immediately without
    // invalidating layout, so there is no feedback loop.
    private static void ApplyToggleIconState(ToggleMenuFlyoutItem item)
    {
        void Apply()
        {
            var state = item.IsChecked ? "CheckedWithIcon" : "UncheckedWithIcon";
            VisualStateManager.GoToState(item, state, false);
        }
        Apply();
        item.LayoutUpdated += (_, _) => Apply();
        item.RegisterPropertyChangedCallback(ToggleMenuFlyoutItem.IsCheckedProperty, (s, _) =>
        {
            var ti = (ToggleMenuFlyoutItem)s;
            VisualStateManager.GoToState(ti, ti.IsChecked ? "CheckedWithIcon" : "UncheckedWithIcon", false);
        });
    }

    private static void ApplyIconPlaceholderState(MenuFlyoutItemBase item)
    {
        VisualStateManager.GoToState(item, "IconPlaceholder", false);
        item.LayoutUpdated += (_, _) => VisualStateManager.GoToState(item, "IconPlaceholder", false);
    }

    // For non-toggle items mixed with toggle items: reserve both check AND icon columns.
    private static void ApplyCheckAndIconPlaceholderState(MenuFlyoutItemBase item)
    {
        VisualStateManager.GoToState(item, "CheckAndIconPlaceholder", false);
        item.LayoutUpdated += (_, _) => VisualStateManager.GoToState(item, "CheckAndIconPlaceholder", false);
    }

    private void SessionItem_PointerEntered(object sender, PointerRoutedEventArgs e)
    {
        if (sender is not Border { Child: SessionMenuLabelView view } border) return;
        view.IsHighlighted = true;
        if (Microsoft.UI.Xaml.Application.Current.Resources.TryGetValue("MenuFlyoutItemBackgroundPointerOver", out var b))
            border.Background = (Brush)b;
    }

    private void SessionItem_PointerExited(object sender, PointerRoutedEventArgs e)
    {
        if (sender is not Border { Child: SessionMenuLabelView view } border) return;
        view.IsHighlighted = false;
        border.Background = null;
    }

    // Dispatches session row taps to the ViewModel command.
    // Required because WinUI 3 does not support RelativeSource FindAncestor in DataTemplates.
    private void SessionItem_Tapped(object sender, TappedRoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: string key } && DataContext is SystemTrayViewModel vm)
            vm.OpenSessionChatCommand.Execute(key);
    }

    // Rebuilds MicPickerSubItem items when AvailableMics changes.
    private void OnDataContextChanged(FrameworkElement sender, DataContextChangedEventArgs e)
    {
        if (DataContext is SystemTrayViewModel vm)
        {
            vm.PropertyChanged -= OnViewModelPropertyChanged;
            vm.PropertyChanged += OnViewModelPropertyChanged;
            RebuildMicItems(vm);
        }
    }

    private void OnViewModelPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(SystemTrayViewModel.AvailableMics)
                           or nameof(SystemTrayViewModel.SelectedMicLabel)
                           or nameof(SystemTrayViewModel.IsSelectedMicUnavailable)
            && DataContext is SystemTrayViewModel vm)
        {
            RebuildMicItems(vm);
        }
    }

    // Populates MicPickerSubItem with a default entry and one entry per available mic.
    private void RebuildMicItems(SystemTrayViewModel vm)
    {
        MicPickerSubItem.Items.Clear();

        if (vm.IsSelectedMicUnavailable)
        {
            MicPickerSubItem.Items.Add(new MenuFlyoutItem
            {
                Text      = "Disconnected (using System default)",
                IsEnabled = false,
            });
            MicPickerSubItem.Items.Add(new MenuFlyoutSeparator());
        }

        var defaultItem = new MenuFlyoutItem { Text = "System default" };
        defaultItem.Click += (_, _) => vm.SetDefaultMicCommand.Execute(null);
        MicPickerSubItem.Items.Add(defaultItem);

        foreach (var mic in vm.AvailableMics)
        {
            var uid = mic.Uid;
            var item = new MenuFlyoutItem { Text = mic.Name };
            item.Click += (_, _) => vm.SetMicCommand.Execute(uid);
            MicPickerSubItem.Items.Add(item);
        }
    }
}
