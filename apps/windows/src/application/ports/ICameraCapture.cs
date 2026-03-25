using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Camera photo and video capture.
/// Implemented by WinRTCameraAdapter (Windows.Media.Capture.MediaCapture).
/// </summary>
public interface ICameraCapture
{
    Task<ErrorOr<JpegSnapshot>> SnapAsync(string deviceId, int? delayMs, CancellationToken ct);
    Task<ErrorOr<CameraClipResult>> RecordClipAsync(string deviceId, int durationMs, bool includeAudio, CancellationToken ct);
}
