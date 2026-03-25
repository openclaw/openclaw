namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Persists the random unattended deep-link key across sessions.
/// </summary>
public interface IDeepLinkKeyStore
{
    string GetOrCreateKey();
}
