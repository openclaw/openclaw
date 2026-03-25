using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Updates;

namespace OpenClawWindows.Infrastructure.Updates;

// No-op updater used for developer-signed / non-production builds.
internal sealed class DisabledUpdaterController : IUpdaterController
{
    public bool IsAvailable => false;
    public UpdateStatus UpdateStatus { get; } = UpdateStatus.Disabled;
    public bool AutomaticallyChecksForUpdates { get; set; }
    public bool AutomaticallyDownloadsUpdates { get; set; }
    public void CheckForUpdates() { }
}
