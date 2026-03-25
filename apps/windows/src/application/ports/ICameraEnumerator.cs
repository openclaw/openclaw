using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Enumerates available camera devices.
/// Implemented by WinRTCameraAdapter (Windows.Devices.Enumeration.DeviceInformation).
/// </summary>
public interface ICameraEnumerator
{
    Task<IReadOnlyList<CameraDeviceInfo>> ListAsync(CancellationToken ct);
}
