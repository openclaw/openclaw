using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Domain.Camera;

namespace OpenClawWindows.Application.ScreenCapture;

[UseCase("UC-020")]
public sealed record ScreenRecordCommand(string ParamsJson) : IRequest<ErrorOr<ScreenRecordingResult>>;

internal sealed class ScreenRecordHandler : IRequestHandler<ScreenRecordCommand, ErrorOr<ScreenRecordingResult>>
{
    private readonly IScreenCapture _screen;
    private readonly IAuditLogger _audit;
    private readonly ILogger<ScreenRecordHandler> _logger;

    public ScreenRecordHandler(IScreenCapture screen, IAuditLogger audit, ILogger<ScreenRecordHandler> logger)
    {
        _screen = screen;
        _audit = audit;
        _logger = logger;
    }

    public async Task<ErrorOr<ScreenRecordingResult>> Handle(ScreenRecordCommand cmd, CancellationToken ct)
    {
        var paramsResult = ScreenRecordingParams.FromJson(cmd.ParamsJson);
        if (paramsResult.IsError)
            return paramsResult.Errors;

        _logger.LogInformation("screen.record durationMs={Duration} fps={Fps}",
            paramsResult.Value.DurationMs, paramsResult.Value.Fps);

        var result = await _screen.RecordAsync(paramsResult.Value, ct);

        await _audit.LogAsync("screen.record", "screen", !result.IsError,
            result.IsError ? result.FirstError.Description : null, ct);

        return result;
    }
}
