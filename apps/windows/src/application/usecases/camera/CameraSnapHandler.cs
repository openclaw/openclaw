using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.Camera;

[UseCase("UC-018")]
public sealed record CameraSnapCommand(string DeviceId, int? DelayMs) : IRequest<ErrorOr<JpegSnapshot>>;

internal sealed class CameraSnapHandler : IRequestHandler<CameraSnapCommand, ErrorOr<JpegSnapshot>>
{
    private readonly ICameraCapture _camera;
    private readonly IAuditLogger _audit;
    private readonly ILogger<CameraSnapHandler> _logger;

    public CameraSnapHandler(ICameraCapture camera, IAuditLogger audit, ILogger<CameraSnapHandler> logger)
    {
        _camera = camera;
        _audit = audit;
        _logger = logger;
    }

    public async Task<ErrorOr<JpegSnapshot>> Handle(CameraSnapCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.DeviceId, nameof(cmd.DeviceId));

        _logger.LogInformation("camera.snap deviceId={DeviceId}", cmd.DeviceId);
        var result = await _camera.SnapAsync(cmd.DeviceId, cmd.DelayMs, ct);

        await _audit.LogAsync("camera.snap", cmd.DeviceId, !result.IsError,
            result.IsError ? result.FirstError.Description : null, ct);

        return result;
    }
}
