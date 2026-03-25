using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Camera;

// camera.clip response — durationMs validated against CaptureRateLimits values.
public sealed record CameraClipResult
{
    public string Base64 { get; }
    public int DurationMs { get; }
    public bool HasAudio { get; }
    public string Format => "mp4";

    private CameraClipResult(string base64, int durationMs, bool hasAudio)
    {
        Base64 = base64;
        DurationMs = durationMs;
        HasAudio = hasAudio;
    }

    public static ErrorOr<CameraClipResult> Create(string base64, int durationMs, bool hasAudio)
    {
        Guard.Against.NullOrWhiteSpace(base64, nameof(base64));

        if (durationMs is < RateLimit.CameraClipMinDurationMs or > RateLimit.CameraClipMaxDurationMs)
            return DomainErrors.Camera.DurationOutOfRange(durationMs);

        return new CameraClipResult(base64, durationMs, hasAudio);
    }
}
