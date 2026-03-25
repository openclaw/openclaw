using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Permissions;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class PermissionsSettingsViewModel : ObservableObject
{
    private readonly IPermissionManager _permissions;

    [ObservableProperty] private bool _isRefreshing;

    // ── Per-capability granted flags ──────────────────────────────────────────

    [ObservableProperty] private bool _notificationsGranted;
    [ObservableProperty] private bool _accessibilityGranted;
    [ObservableProperty] private bool _screenRecordingGranted;
    [ObservableProperty] private bool _microphoneGranted;
    [ObservableProperty] private bool _speechRecognitionGranted;
    [ObservableProperty] private bool _cameraGranted;
    [ObservableProperty] private bool _locationGranted;

    // ── Derived Visibility — no converters in App.xaml ────────────────────────

    public Visibility NotificationsGrantedVisibility    => _notificationsGranted     ? Visibility.Visible : Visibility.Collapsed;
    public Visibility NotificationsWarningVisibility    => !_notificationsGranted    ? Visibility.Visible : Visibility.Collapsed;

    public Visibility AccessibilityGrantedVisibility    => _accessibilityGranted     ? Visibility.Visible : Visibility.Collapsed;
    public Visibility AccessibilityWarningVisibility    => !_accessibilityGranted    ? Visibility.Visible : Visibility.Collapsed;

    public Visibility ScreenRecordingGrantedVisibility  => _screenRecordingGranted   ? Visibility.Visible : Visibility.Collapsed;
    public Visibility ScreenRecordingWarningVisibility  => !_screenRecordingGranted  ? Visibility.Visible : Visibility.Collapsed;

    public Visibility MicrophoneGrantedVisibility       => _microphoneGranted        ? Visibility.Visible : Visibility.Collapsed;
    public Visibility MicrophoneWarningVisibility       => !_microphoneGranted       ? Visibility.Visible : Visibility.Collapsed;

    public Visibility SpeechRecognitionGrantedVisibility => _speechRecognitionGranted  ? Visibility.Visible : Visibility.Collapsed;
    public Visibility SpeechRecognitionWarningVisibility => !_speechRecognitionGranted ? Visibility.Visible : Visibility.Collapsed;

    public Visibility CameraGrantedVisibility           => _cameraGranted            ? Visibility.Visible : Visibility.Collapsed;
    public Visibility CameraWarningVisibility           => !_cameraGranted           ? Visibility.Visible : Visibility.Collapsed;

    public Visibility LocationGrantedVisibility         => _locationGranted          ? Visibility.Visible : Visibility.Collapsed;
    public Visibility LocationWarningVisibility         => !_locationGranted         ? Visibility.Visible : Visibility.Collapsed;

    // ── Partial change hooks — notify derived Visibility pairs ────────────────

    partial void OnNotificationsGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(NotificationsGrantedVisibility));
        OnPropertyChanged(nameof(NotificationsWarningVisibility));
    }

    partial void OnAccessibilityGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(AccessibilityGrantedVisibility));
        OnPropertyChanged(nameof(AccessibilityWarningVisibility));
    }

    partial void OnScreenRecordingGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(ScreenRecordingGrantedVisibility));
        OnPropertyChanged(nameof(ScreenRecordingWarningVisibility));
    }

    partial void OnMicrophoneGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(MicrophoneGrantedVisibility));
        OnPropertyChanged(nameof(MicrophoneWarningVisibility));
    }

    partial void OnSpeechRecognitionGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(SpeechRecognitionGrantedVisibility));
        OnPropertyChanged(nameof(SpeechRecognitionWarningVisibility));
    }

    partial void OnCameraGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(CameraGrantedVisibility));
        OnPropertyChanged(nameof(CameraWarningVisibility));
    }

    partial void OnLocationGrantedChanged(bool value)
    {
        OnPropertyChanged(nameof(LocationGrantedVisibility));
        OnPropertyChanged(nameof(LocationWarningVisibility));
    }

    // ─────────────────────────────────────────────────────────────────────────

    public PermissionsSettingsViewModel(IPermissionManager permissions)
    {
        _permissions = permissions;
    }

    [RelayCommand]
    private async Task RefreshAsync()
    {
        IsRefreshing = true;
        var status = await _permissions.StatusAsync();

        NotificationsGranted     = status.GetValueOrDefault(Capability.Notifications);
        AccessibilityGranted     = status.GetValueOrDefault(Capability.Accessibility);
        ScreenRecordingGranted   = status.GetValueOrDefault(Capability.ScreenRecording);
        MicrophoneGranted        = status.GetValueOrDefault(Capability.Microphone);
        SpeechRecognitionGranted = status.GetValueOrDefault(Capability.SpeechRecognition);
        CameraGranted            = status.GetValueOrDefault(Capability.Camera);
        LocationGranted          = status.GetValueOrDefault(Capability.Location);

        IsRefreshing = false;
    }

    // CommandParameter is the Capability enum name as string (e.g. "Camera").
    [RelayCommand]
    private void OpenSettings(string capName)
    {
        if (Enum.TryParse<Capability>(capName, out var cap))
            _permissions.OpenSettings(cap);
    }
}
