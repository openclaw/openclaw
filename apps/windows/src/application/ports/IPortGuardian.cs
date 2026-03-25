using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Detects and terminates stray processes holding the gateway port before each gateway start.
/// </summary>
public interface IPortGuardian
{
    Task SweepAsync(ConnectionMode mode);
}
