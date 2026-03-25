using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Screen recording port.
/// Implemented by WinRTScreenCaptureAdapter (Windows.Graphics.Capture.GraphicsCaptureSession).
/// </summary>
public interface IScreenCapture
{
    Task<ErrorOr<ScreenRecordingResult>> RecordAsync(ScreenRecordingParams p, CancellationToken ct);
}
