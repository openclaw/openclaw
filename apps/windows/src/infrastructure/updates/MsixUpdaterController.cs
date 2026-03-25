using System.Text.Json;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Updates;
using Windows.Management.Deployment;

namespace OpenClawWindows.Infrastructure.Updates;

// MSIX equivalent of SparkleUpdaterController (macOS).
// Fetches a version manifest from AppcastUrl, compares with the installed package version,
// and calls PackageManager.AddPackageAsync to stage the update when available.
// IsUpdateReady = true once the package has been successfully staged.
internal sealed class MsixUpdaterController : IUpdaterController
{
    // Replace with the real appcast endpoint before shipping.
    private const string AppcastUrl = "https://releases.openclaw.ai/windows/appcast.json";

    private readonly UpdateStatus _status = new();
    private readonly ILogger<MsixUpdaterController> _log;

    public bool IsAvailable => true;
    public UpdateStatus UpdateStatus => _status;
    public bool AutomaticallyChecksForUpdates { get; set; }
    public bool AutomaticallyDownloadsUpdates { get; set; }

    public MsixUpdaterController(bool savedAutoUpdate, ILogger<MsixUpdaterController> log)
    {
        AutomaticallyChecksForUpdates = savedAutoUpdate;
        AutomaticallyDownloadsUpdates = savedAutoUpdate;
        _log = log;

        // Mirror Sparkle: start background check immediately if auto-update is on.
        if (savedAutoUpdate)
            _ = CheckInternalAsync();
    }

    public void CheckForUpdates() => _ = CheckInternalAsync();

    private async Task CheckInternalAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            var json = await http.GetStringAsync(AppcastUrl);

            var manifest = JsonSerializer.Deserialize<AppcastManifest>(json,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (manifest?.MsixUrl is null || manifest.Version is null) return;

            var current = Windows.ApplicationModel.Package.Current.Id.Version;
            if (!Version.TryParse(manifest.Version, out var remote)) return;

            var currentVersion = new Version(current.Major, current.Minor, current.Build, current.Revision);
            if (remote <= currentVersion) return;

            _log.LogInformation("Update available: {Remote} (current {Current})", remote, currentVersion);

            // Only stage the package when auto-download is on or user triggered CheckForUpdates().
            if (!AutomaticallyDownloadsUpdates) return;
            await StageUpdateAsync(new Uri(manifest.MsixUrl));
        }
        catch (Exception ex)
        {
            // Non-fatal — background update checks should never crash the app.
            _log.LogDebug(ex, "Update check failed");
            _status.IsUpdateReady = false;
        }
    }

    private async Task StageUpdateAsync(Uri msixUri)
    {
        try
        {
            var mgr = new PackageManager();
            var op  = mgr.AddPackageAsync(msixUri, null, DeploymentOptions.ForceUpdateFromAnyVersion);

            // Report progress without blocking the UI thread.
            var tcs = new TaskCompletionSource();
            op.Completed = (asyncOp, _) =>
            {
                try
                {
                    asyncOp.GetResults();
                    _status.IsUpdateReady = true;
                    _log.LogInformation("Update staged successfully");
                }
                catch (Exception ex)
                {
                    _log.LogWarning(ex, "Update staging failed");
                    _status.IsUpdateReady = false;
                }
                finally { tcs.TrySetResult(); }
            };

            await tcs.Task;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to initiate package update");
            _status.IsUpdateReady = false;
        }
    }

    private sealed class AppcastManifest
    {
        public string? Version { get; set; }
        public string? MsixUrl { get; set; }
    }
}
