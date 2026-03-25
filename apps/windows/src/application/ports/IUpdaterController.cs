using OpenClawWindows.Domain.Updates;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Abstraction over the platform update mechanism.
/// </summary>
public interface IUpdaterController
{
    bool IsAvailable { get; }
    UpdateStatus UpdateStatus { get; }
    bool AutomaticallyChecksForUpdates { get; set; }
    bool AutomaticallyDownloadsUpdates { get; set; }
    void CheckForUpdates();
}
