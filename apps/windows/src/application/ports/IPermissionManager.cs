using OpenClawWindows.Domain.Permissions;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Central permission verification and request gateway.
/// </summary>
public interface IPermissionManager
{
    Task<IReadOnlyDictionary<Capability, bool>> StatusAsync(
        IEnumerable<Capability>? caps = null, CancellationToken ct = default);

    Task<IReadOnlyDictionary<Capability, bool>> EnsureAsync(
        IEnumerable<Capability> caps, bool interactive, CancellationToken ct = default);

    bool VoiceWakePermissionsGranted();

    Task<bool> EnsureVoiceWakePermissionsAsync(bool interactive, CancellationToken ct = default);

    void OpenSettings(Capability cap);
}
