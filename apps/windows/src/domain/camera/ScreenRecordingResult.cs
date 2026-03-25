using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Camera;

// screen.record response.
public sealed record ScreenRecordingResult
{
    public string Base64 { get; }
    public int DurationMs { get; }
    public float Fps { get; }
    public int ScreenIndex { get; }
    public bool HasAudio { get; }
    public string Format => "mp4";

    private ScreenRecordingResult(string base64, int durationMs, float fps, int screenIndex, bool hasAudio)
    {
        Base64 = base64;
        DurationMs = durationMs;
        Fps = fps;
        ScreenIndex = screenIndex;
        HasAudio = hasAudio;
    }

    public static ErrorOr<ScreenRecordingResult> Create(string base64, int durationMs, float fps,
        int screenIndex, bool hasAudio)
    {
        Guard.Against.NullOrWhiteSpace(base64, nameof(base64));

        if (durationMs is < RateLimit.ScreenRecordMinDurationMs or > RateLimit.ScreenRecordMaxDurationMs)
            return DomainErrors.Screen.DurationOutOfRange(durationMs);

        if (fps is < RateLimit.ScreenRecordMinFps or > RateLimit.ScreenRecordMaxFps)
            return DomainErrors.Screen.FpsOutOfRange((int)fps);

        Guard.Against.Negative(screenIndex, nameof(screenIndex));

        return new ScreenRecordingResult(base64, durationMs, fps, screenIndex, hasAudio);
    }
}
