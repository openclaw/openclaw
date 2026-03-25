using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Windows;

/// <summary>
/// Inner content of the voice overlay bubble.
/// manages focus transitions, wires send/dismiss/editing callbacks.
/// </summary>
internal sealed partial class VoiceOverlayInnerView : UserControl
{
    public VoiceOverlayInnerView()
    {
        InitializeComponent();
        DataContextChanged += OnDataContextChanged;
    }

    private void OnDataContextChanged(FrameworkElement sender, DataContextChangedEventArgs args)
    {
        if (args.NewValue is VoiceOverlayViewModel vm)
            WireCallbacks(vm);
    }

    private void WireCallbacks(VoiceOverlayViewModel vm)
    {
        // N4-02 → begin editing on tap
        ReadOnlyLabel.OnTap = () =>
        {
            vm.UserBeganEditing();
            EditableText.Focus(FocusState.Programmatic);
        };

        // N4-01 → editing lifecycle
        EditableText.OnBeginEditing = () => vm.UserBeganEditing();
        EditableText.OnEndEditing   = () => { /* IsEditing flows back through vm.UserBeganEditing / dismiss path */ };
        EditableText.OnEscape       = () => vm.DismissCommand.Execute(null);
        EditableText.OnSend         = () =>
        {
            // only fires when forwardEnabled
            if (vm.CanSend)
                _ = vm.SendCommand.ExecuteAsync(null);
        };
    }

    // ── Focus management ──────────────────────────────────────────────────────

    internal void UpdateFocusState(bool isVisible, bool isEditing)
    {
        if (isVisible && isEditing)
            EditableText.Focus(FocusState.Programmatic);
    }
}
