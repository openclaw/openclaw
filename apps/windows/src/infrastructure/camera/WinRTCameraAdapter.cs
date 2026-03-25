using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Devices.Enumeration;
using Windows.Media.Capture;
using Windows.Media.MediaProperties;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Infrastructure.Camera;

internal sealed class WinRTCameraAdapter : ICameraCapture, ICameraEnumerator, IAsyncDisposable
{
    private readonly ILogger<WinRTCameraAdapter> _logger;
    private MediaCapture? _activeCapture;

    // Tunables
    private const int JpegQuality = 90;              // matches macOS default JPEG quality
    private const int SnapResolutionWidth = 1280;    // max width for snaps
    private const int SnapResolutionHeight = 720;

    public WinRTCameraAdapter(ILogger<WinRTCameraAdapter> logger)
    {
        _logger = logger;
    }

    public async Task<IReadOnlyList<CameraDeviceInfo>> ListAsync(CancellationToken ct)
    {
        var devices = await DeviceInformation
            .FindAllAsync(DeviceClass.VideoCapture)
            .AsTask(ct);

        return devices
            .Select(d => CameraDeviceInfo.Create(
                id: d.Id,
                name: d.Name,
                position: d.EnclosureLocation is null ? "unspecified"
                    : d.EnclosureLocation.Panel == Windows.Devices.Enumeration.Panel.Front ? "front"
                    : d.EnclosureLocation.Panel == Windows.Devices.Enumeration.Panel.Back ? "back"
                    : "unspecified",
                deviceType: "builtInWideAngleCamera"))
            .ToList();
    }

    public async Task<ErrorOr<JpegSnapshot>> SnapAsync(
        string deviceId, int? delayMs, CancellationToken ct)
    {
        if (delayMs is > 0)
            await Task.Delay(delayMs.Value, ct);

        var capture = new MediaCapture();
        try
        {
            var settings = new MediaCaptureInitializationSettings
            {
                VideoDeviceId = deviceId,
                StreamingCaptureMode = StreamingCaptureMode.Video,
            };

            await capture.InitializeAsync(settings).AsTask(ct);

            // Low-resolution JPEG stream: camera → InMemoryRandomAccessStream → byte[]
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            var props = ImageEncodingProperties.CreateJpeg();
            props.Width = (uint)SnapResolutionWidth;
            props.Height = (uint)SnapResolutionHeight;

            await capture.CapturePhotoToStreamAsync(props, stream).AsTask(ct);

            stream.Seek(0);
            var bytes = new byte[stream.Size];
            await stream.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length,
                Windows.Storage.Streams.InputStreamOptions.None).AsTask(ct);

            var base64 = Convert.ToBase64String(bytes);
            return JpegSnapshot.Create(base64, SnapResolutionWidth, SnapResolutionHeight);
        }
        catch (Exception ex) when (ex.HResult == unchecked((int)0x80070005))
        {
            // Access denied — camera permission not granted
            _logger.LogWarning("Camera permission denied for device {Id}", deviceId);
            return Error.Failure("PERMISSION_MISSING: camera");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Camera snap failed for device {Id}", deviceId);
            return Error.Failure("Camera unavailable");
        }
        finally
        {
            capture.Dispose();
        }
    }

    public async Task<ErrorOr<CameraClipResult>> RecordClipAsync(
        string deviceId, int durationMs, bool includeAudio, CancellationToken ct)
    {
        // Validate durationMs against CaptureRateLimits — MUST mirror macOS
        if (durationMs is < 250 or > 60_000)
            return Error.Failure("INVALID_REQUEST: durationMs must be 250..60000");

        var capture = new MediaCapture();
        try
        {
            var settings = new MediaCaptureInitializationSettings
            {
                VideoDeviceId = deviceId,
                StreamingCaptureMode = includeAudio
                    ? StreamingCaptureMode.AudioAndVideo
                    : StreamingCaptureMode.Video,
            };

            await capture.InitializeAsync(settings).AsTask(ct);

            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            var profile = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Auto);
            await capture.StartRecordToStreamAsync(profile, stream).AsTask(ct);

            await Task.Delay(durationMs, ct);

            await capture.StopRecordAsync().AsTask(ct);

            stream.Seek(0);
            var bytes = new byte[stream.Size];
            await stream.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length,
                Windows.Storage.Streams.InputStreamOptions.None).AsTask(ct);

            var base64 = Convert.ToBase64String(bytes);
            return CameraClipResult.Create(base64, durationMs, hasAudio: includeAudio);
        }
        catch (Exception ex) when (ex.HResult == unchecked((int)0x80070005))
        {
            _logger.LogWarning("Camera permission denied for clip on device {Id}", deviceId);
            return Error.Failure("PERMISSION_MISSING: camera");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Camera clip failed for device {Id}", deviceId);
            return Error.Failure("Camera unavailable");
        }
        finally
        {
            capture.Dispose();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_activeCapture is not null)
        {
            await _activeCapture.StopRecordAsync().AsTask(CancellationToken.None);
            _activeCapture.Dispose();
            _activeCapture = null;
        }
    }
}
