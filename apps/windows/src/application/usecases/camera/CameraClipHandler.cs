using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.Camera;

[UseCase("UC-019")]
public sealed record CameraClipCommand(string DeviceId, int DurationMs, bool IncludeAudio)
    : IRequest<ErrorOr<CameraClipResult>>;

internal sealed class CameraClipHandler : IRequestHandler<CameraClipCommand, ErrorOr<CameraClipResult>>
{
    private readonly ICameraCapture _camera;
    private readonly IAuditLogger _audit;
    private readonly ILogger<CameraClipHandler> _logger;

    public CameraClipHandler(ICameraCapture camera, IAuditLogger audit, ILogger<CameraClipHandler> logger)
    {
        _camera = camera;
        _audit = audit;
        _logger = logger;
    }

    public async Task<ErrorOr<CameraClipResult>> Handle(CameraClipCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.DeviceId, nameof(cmd.DeviceId));

        _logger.LogInformation("camera.clip deviceId={DeviceId} durationMs={Duration}", cmd.DeviceId, cmd.DurationMs);
        var result = await _camera.RecordClipAsync(cmd.DeviceId, cmd.DurationMs, cmd.IncludeAudio, ct);

        await _audit.LogAsync("camera.clip", cmd.DeviceId, !result.IsError,
            result.IsError ? result.FirstError.Description : null, ct);

        return result;
    }
}
