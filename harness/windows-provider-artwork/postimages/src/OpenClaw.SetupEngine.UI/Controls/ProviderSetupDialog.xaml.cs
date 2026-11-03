using System.Text.Json;
using System.Diagnostics;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace OpenClaw.SetupEngine.UI.Controls;

/// <summary>One page-owned prompt surface. It renders inputs, never owns a Gateway client.</summary>
public sealed partial class ProviderSetupDialog : ContentDialog
{
    private GatewayAiSetupWizardStep? _step;
    private Task _showTask = Task.CompletedTask;
    private bool _allowClose;
    private bool _requested;
    private bool _closed;
    private bool _rendering;
    private bool _canAnswer;
    private bool _canActivatePrepared;
    public event Action? ContinueRequested;
    public event Action? RefreshRequested;
    public event Action? CancelRequested;
    public event Action<string?>? ExternalLinkRequested;
    public event Action<NativeSetupRecoveryAction>? NativeRecoveryRequested;

    public void UpdateNativeRecovery(bool available, string output)
    {
        NativeRecovery.Visibility = available ? Visibility.Visible : Visibility.Collapsed;
        if (!available) NativeRecovery.IsExpanded = false;
        NativeOutput.Text = available ? output : "";
    }

    private void NativeRecovery_Click(object sender, RoutedEventArgs e)
    {
        if (!_closed && sender is FrameworkElement { Tag: string tag } &&
            Enum.TryParse<NativeSetupRecoveryAction>(tag, out var action))
            NativeRecoveryRequested?.Invoke(action);
    }

    public ProviderSetupDialog()
    {
        InitializeComponent();
        PrimaryButtonText = S("Continue.Content");
        SecondaryButtonText = S("Refresh.Content");
        CancelButton.Content = S("Cancel.Content");
        ExternalLink.Content = S("OpenLink.Content");
        CopyCodeButton.Content = S("CopyCode");
        ConfirmInput.Content = S("Confirm.Content");
    }

    public Task ShowOwnedAsync(XamlRoot root, ElementTheme theme)
    {
        if (_closed)
            return _showTask;
        _requested = true;
        if (!_showTask.IsCompleted)
            return _showTask;
        XamlRoot = root;
        RequestedTheme = theme;
        _allowClose = false;
        return _showTask = ShowCoreAsync();
    }

    private async Task ShowCoreAsync()
    {
        do
        {
            _allowClose = false;
            await ShowAsync();
        }
        while (_requested && !_closed);
    }

    public void Dismiss()
    {
        _allowClose = true;
        _requested = false;
        _canAnswer = false;
        _canActivatePrepared = false;
        ClearInputs();
        _step = null;
        StepOptions.ItemsSource = null;
        StepMessage.Text = "";
        // The page owns this session. Detaching cancels only this control and
        // releases its subscription, without closing artwork on the chooser.
        ProviderIcon.Session = null;
        ProviderIcon.Descriptor = null;
        ProviderIcon.Visibility = Visibility.Collapsed;
        ProviderHeader.Visibility = Visibility.Collapsed;
        Hide();
    }

    public Task CloseAsync()
    {
        _closed = true;
        Dismiss();
        return _showTask;
    }

    public void Update(GatewayAiSetupWizardStep? step, GatewayAiSetupPhase phase,
        bool busy, bool canCancel, bool cancelling, string status, string? error, string? providerTitle = null,
        bool isSubmittingAnswer = false, ProviderArtworkDescriptor? providerArtwork = null,
        ProviderArtworkSession? artworkSession = null)
    {
        if (_closed)
            return;
        _rendering = true;
        try
        {
            var showStep = GatewayAiSetupPresentation.ShowProviderStep(step, phase, busy, isSubmittingAnswer);
            Title = step?.Title ?? providerTitle ?? S("Title.Text");
            ProviderIcon.Descriptor = providerArtwork;
            ProviderIcon.Session = artworkSession;
            ProviderIcon.Visibility = providerArtwork is not null ? Visibility.Visible : Visibility.Collapsed;
            ProviderName.Text = providerTitle ?? "";
            ProviderName.Visibility = !string.IsNullOrWhiteSpace(providerTitle) &&
                (providerArtwork is not null || step?.Title is not null &&
                    !string.Equals(step.Title, providerTitle, StringComparison.Ordinal))
                ? Visibility.Visible : Visibility.Collapsed;
            ProviderHeader.Visibility = ProviderIcon.Visibility == Visibility.Visible || ProviderName.Visibility == Visibility.Visible
                ? Visibility.Visible : Visibility.Collapsed;
            DialogStatus.Text = cancelling ? S("Cancelling") : status;
            DialogStatus.Visibility = !cancelling && phase == GatewayAiSetupPhase.Running && step is not null
                ? Visibility.Collapsed : Visibility.Visible;
            DialogError.Message = error ?? "";
            DialogError.IsOpen = !string.IsNullOrWhiteSpace(error);
            _canAnswer = phase == GatewayAiSetupPhase.Running && !busy && !cancelling;
            _canActivatePrepared = phase == GatewayAiSetupPhase.Prepared && !busy && !cancelling;
            StepPanel.Visibility = showStep ? Visibility.Visible : Visibility.Collapsed;
            if (!ReferenceEquals(_step, step))
                RenderStep(step);
            if (!showStep)
                ClearInputs();
            StepOptions.IsEnabled = TextInput.IsEnabled = SecretInput.IsEnabled = ConfirmInput.IsEnabled = _canAnswer;
            ExternalLink.IsEnabled = !cancelling;
            DialogProgress.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
            CancelButton.IsEnabled = canCancel && !cancelling;
            CancelButton.Visibility = canCancel || cancelling ? Visibility.Visible : Visibility.Collapsed;
            var canReconcile = phase is GatewayAiSetupPhase.Uncertain or GatewayAiSetupPhase.VerificationRequired;
            SecondaryButtonText = canReconcile && !busy && !cancelling ? S("Recheck") : "";
            IsSecondaryButtonEnabled = canReconcile && !busy && !cancelling;
            PrimaryButtonText = phase == GatewayAiSetupPhase.Prepared ? S("ActivatePrepared") :
                phase == GatewayAiSetupPhase.Running &&
                GatewayAiSetupPresentation.GetPromptAction(step) is { } action ? S(action) : "";
        }
        finally { _rendering = false; }
        UpdateAdmission();
    }

    public bool CanSubmit => !_closed && _canAnswer && _step is { } step &&
        step.Type != "progress" && step.Executor != "gateway" &&
        (step.Type != "select" || StepOptions.SelectedItem is not null);

    public JsonElement? TakeAnswer()
    {
        if (!CanSubmit || _step is not { } step)
            throw new InvalidOperationException("The provider prompt is not accepting an answer.");
        JsonElement? value = step.Type switch
        {
            "confirm" => JsonSerializer.SerializeToElement(ConfirmInput.IsChecked == true),
            "text" => JsonSerializer.SerializeToElement(step.Sensitive ? SecretInput.Password : TextInput.Text),
            "select" => ((GatewayAiSetupWizardOption)StepOptions.SelectedItem).Value,
            "multiselect" => JsonSerializer.SerializeToElement(StepOptions.SelectedItems.Cast<GatewayAiSetupWizardOption>().Select(o => o.Value)),
            _ => null,
        };
        SecretInput.Password = "";
        return value;
    }

    public void ClearInputs()
    {
        SecretInput.Password = "";
        TextInput.Text = "";
        StepOptions.SelectedIndex = -1;
        if (StepOptions.SelectionMode is ListViewSelectionMode.Multiple or ListViewSelectionMode.Extended)
            StepOptions.SelectedItems.Clear();
        ConfirmInput.IsChecked = false;
        DeviceCode.Text = "";
        DeviceCodeDetail.Text = "";
        CopyCodeButton.Visibility = Visibility.Collapsed;
    }

    private void RenderStep(GatewayAiSetupWizardStep? step)
    {
        ClearInputs();
        _step = step;
        StepMessage.Text = step?.DeviceCode is null ? step?.Message ?? "" : "";
        StepMessage.Visibility = string.IsNullOrWhiteSpace(StepMessage.Text) ? Visibility.Collapsed : Visibility.Visible;
        if (step is null)
            return;
        TextInput.Text = step.Sensitive ? "" : step.InitialValue is { ValueKind: JsonValueKind.String } initial ? initial.GetString()! : "";
        TextInput.PlaceholderText = SecretInput.PlaceholderText = step.Placeholder ?? S("Value");
        AutomationProperties.SetName(TextInput, step.Title ?? S("Value"));
        AutomationProperties.SetName(SecretInput, step.Title ?? S("Value"));
        AutomationProperties.SetName(StepOptions, step.Title ?? S("Value"));
        AutomationProperties.SetName(ConfirmInput, step.Title ?? S("Confirm.Content"));
        ConfirmInput.IsChecked = step.InitialValue is { ValueKind: JsonValueKind.True };
        StepOptions.SelectionMode = step.Type == "multiselect" ? ListViewSelectionMode.Multiple : ListViewSelectionMode.Single;
        StepOptions.ItemsSource = step.Options;
        foreach (var option in GatewayAiSetupPresentation.GetInitialOptions(step))
            if (step.Type == "multiselect")
                StepOptions.SelectedItems.Add(option);
            else
                StepOptions.SelectedItem = option;
        TextInput.Visibility = step.Type == "text" && !step.Sensitive ? Visibility.Visible : Visibility.Collapsed;
        SecretInput.Visibility = step.Type == "text" && step.Sensitive ? Visibility.Visible : Visibility.Collapsed;
        StepOptions.Visibility = step.Type is "select" or "multiselect" ? Visibility.Visible : Visibility.Collapsed;
        ConfirmInput.Visibility = step.Type == "confirm" ? Visibility.Visible : Visibility.Collapsed;
        ExternalLink.Visibility = step.ExternalUrl is not null ? Visibility.Visible : Visibility.Collapsed;
        DeviceCode.Visibility = DeviceCodeDetail.Visibility = step.DeviceCode is not null ? Visibility.Visible : Visibility.Collapsed;
        CopyCodeButton.Visibility = DeviceCode.Visibility;
        DeviceCode.Text = step.DeviceCode?.Code ?? "";
        DeviceCodeDetail.Text = step.DeviceCode is { } code
            ? code.Message + (code.ExpiresInMinutes is { } minutes ? Environment.NewLine + SetupLocalization.Format("Onboarding_AiSetup_CodeExpiry", minutes) : "")
            : "";
    }

    private void UpdateAdmission()
    {
        if (!_rendering)
            IsPrimaryButtonEnabled = !_closed && (CanSubmit || _canActivatePrepared);
    }

    private void Continue_Click(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        args.Cancel = true;
        if (!_closed && (CanSubmit || _canActivatePrepared))
            ContinueRequested?.Invoke();
    }

    private void Refresh_Click(ContentDialog sender, ContentDialogButtonClickEventArgs args)
    {
        args.Cancel = true;
        if (!_closed && IsSecondaryButtonEnabled)
            RefreshRequested?.Invoke();
    }

    private void Cancel_Click(object sender, RoutedEventArgs e) => RequestCancel();

    private void RequestCancel()
    {
        if (!_closed && CancelButton.IsEnabled)
        {
            ClearInputs();
            CancelRequested?.Invoke();
        }
    }

    private void Dialog_Closing(ContentDialog sender, ContentDialogClosingEventArgs args)
    {
        if (_allowClose)
            return;
        // Escape is a cancellation request, not evidence that the Gateway rolled back.
        args.Cancel = true;
        RequestCancel();
    }

    private void ExternalLink_Click(object sender, RoutedEventArgs e)
    {
        if (!_closed)
            ExternalLinkRequested?.Invoke(_step?.ExternalUrl);
    }

    private void CopyCode_Click(object sender, RoutedEventArgs e)
    {
        if (_closed || _step?.DeviceCode is not { } code || string.IsNullOrEmpty(code.Code))
            return;
        try
        {
            var data = new Windows.ApplicationModel.DataTransfer.DataPackage();
            data.SetText(code.Code);
            Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);
        }
        catch (Exception ex)
        {
            Trace.TraceWarning("Provider device code copy failed ({0}).", ex.GetType().Name);
            DialogError.Message = S("CopyFailed");
            DialogError.IsOpen = true;
        }
    }

    private void Input_Changed(object sender, RoutedEventArgs e) => UpdateAdmission();
    private void TextInput_Changed(object sender, TextChangedEventArgs e) => UpdateAdmission();
    private void Options_Changed(object sender, SelectionChangedEventArgs e) => UpdateAdmission();
    private static string S(string key) => SetupLocalization.GetString("Onboarding_AiSetup_" + key);
}
