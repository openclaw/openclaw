using Windows.Devices.Enumeration;
using Windows.Devices.Geolocation;
using Windows.Graphics.Capture;
using Windows.Media.Capture;
using Windows.System;
using Windows.UI.Notifications;
using OpenClawWindows.Domain.Permissions;

namespace OpenClawWindows.Infrastructure.Permissions;

// Central permission check and request adapter.
internal sealed class WindowsPermissionManager : IPermissionManager
{
    private static readonly Capability[] AllCaps = (Capability[])Enum.GetValues(typeof(Capability));

    // ms-settings: URIs matching the per-capability Settings pane.
    private static readonly IReadOnlyDictionary<Capability, string> SettingsUris =
        new Dictionary<Capability, string>
        {
            [Capability.Microphone]        = "ms-settings:privacy-microphone",
            [Capability.Camera]            = "ms-settings:privacy-webcam",
            [Capability.Location]          = "ms-settings:privacy-location",
            [Capability.SpeechRecognition] = "ms-settings:privacy-speechtyping",
            [Capability.ScreenRecording]   = "ms-settings:privacy-graphicscaptureprogrammatic",
            [Capability.Notifications]     = "ms-settings:notifications",
            [Capability.Accessibility]     = "ms-settings:easeofaccess",
        };

    private readonly ILogger<WindowsPermissionManager> _logger;

    public WindowsPermissionManager(ILogger<WindowsPermissionManager> logger)
    {
        _logger = logger;
    }

    public async Task<IReadOnlyDictionary<Capability, bool>> StatusAsync(
        IEnumerable<Capability>? caps = null, CancellationToken ct = default)
    {
        var targets = caps ?? AllCaps;
        var results = new Dictionary<Capability, bool>();
        foreach (var cap in targets)
            results[cap] = await CheckAsync(cap, ct);
        return results;
    }

    public async Task<IReadOnlyDictionary<Capability, bool>> EnsureAsync(
        IEnumerable<Capability> caps, bool interactive, CancellationToken ct = default)
    {
        var results = new Dictionary<Capability, bool>();
        foreach (var cap in caps)
            results[cap] = await EnsureCapabilityAsync(cap, interactive, ct);
        return results;
    }

    public bool VoiceWakePermissionsGranted()
    {
        // sync fast path.
        var mic    = DeviceAccessInformation.CreateFromDeviceClass(DeviceClass.AudioCapture);
        return mic.CurrentStatus == DeviceAccessStatus.Allowed;
    }

    public async Task<bool> EnsureVoiceWakePermissionsAsync(bool interactive, CancellationToken ct = default)
    {
        var results = await EnsureAsync([Capability.Microphone, Capability.SpeechRecognition], interactive, ct);
        return results[Capability.Microphone] && results[Capability.SpeechRecognition];
    }

    public void OpenSettings(Capability cap)
    {
        if (!SettingsUris.TryGetValue(cap, out var uri)) return;
        _ = Launcher.LaunchUriAsync(new Uri(uri));
    }

    // ── private helpers ──────────────────────────────────────────────────────

    private async Task<bool> CheckAsync(Capability cap, CancellationToken ct)
    {
        return cap switch
        {
            Capability.Microphone        => CheckDevice(DeviceClass.AudioCapture),
            Capability.Camera            => CheckDevice(DeviceClass.VideoCapture),
            Capability.SpeechRecognition => CheckDevice(DeviceClass.AudioCapture),
            Capability.Location          => await CheckLocationAsync(),
            Capability.ScreenRecording   => CheckScreenRecording(),
            Capability.Notifications     => CheckNotifications(),
            // Windows does not gate accessibility behind a runtime TCC prompt.
            Capability.Accessibility     => true,
            _                            => false,
        };
    }

    private async Task<bool> EnsureCapabilityAsync(Capability cap, bool interactive, CancellationToken ct)
    {
        var granted = await CheckAsync(cap, ct);
        if (granted) return true;
        if (!interactive) return false;

        switch (cap)
        {
            case Capability.Microphone:
                return await RequestMediaCaptureAsync(StreamingCaptureMode.Audio, ct);
            case Capability.Camera:
                return await RequestMediaCaptureAsync(StreamingCaptureMode.Video, ct);
            case Capability.SpeechRecognition:
                // Speech recognition shares the microphone permission on Windows.
                return await RequestMediaCaptureAsync(StreamingCaptureMode.Audio, ct);
            case Capability.Location:
                return await RequestLocationAsync();
            default:
                // ScreenRecording, Notifications, Accessibility: open settings page.
                OpenSettings(cap);
                return false;
        }
    }

    private static bool CheckDevice(DeviceClass deviceClass)
    {
        var info = DeviceAccessInformation.CreateFromDeviceClass(deviceClass);
        return info.CurrentStatus == DeviceAccessStatus.Allowed;
    }

    private static async Task<bool> CheckLocationAsync()
    {
        var access = await Geolocator.RequestAccessAsync();
        return access == GeolocationAccessStatus.Allowed;
    }

    private static bool CheckScreenRecording()
    {
        if (!GraphicsCaptureSession.IsSupported()) return false;
        // GraphicsCaptureAccess.CheckAccess requires Windows 11 (build 22000+);
        // on Windows 10 (19041) capture access is implicitly granted when session is supported.
        return true;
    }

    private static bool CheckNotifications()
    {
        try
        {
            var notifier = ToastNotificationManager.CreateToastNotifier();
            return notifier.Setting == NotificationSetting.Enabled;
        }
        catch
        {
            return false;
        }
    }

    // Requesting mic/camera triggers the system consent dialog via MediaCapture.InitializeAsync.
    // Must be called from a UI thread when interactive.
    private async Task<bool> RequestMediaCaptureAsync(StreamingCaptureMode mode, CancellationToken ct)
    {
        try
        {
            using var capture = new MediaCapture();
            await capture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = mode,
            }).AsTask(ct);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Media capture permission request denied for {Mode}", mode);
            return false;
        }
    }

    private async Task<bool> RequestLocationAsync()
    {
        var access = await Geolocator.RequestAccessAsync();
        if (access != GeolocationAccessStatus.Allowed)
            OpenSettings(Capability.Location);
        return access == GeolocationAccessStatus.Allowed;
    }
}
