using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Camera;

public sealed class CameraSession : Entity<string>
{
    public CameraSessionState State { get; private set; }
    public DateTimeOffset? CaptureStartedAt { get; private set; }

    private CameraSession(string deviceId)
    {
        Guard.Against.NullOrWhiteSpace(deviceId, nameof(deviceId));
        Id = deviceId;
        State = CameraSessionState.Idle;
    }

    public static CameraSession Create(string deviceId) =>
        new(deviceId);

    public void BeginPhotoCapture()
    {
        if (State != CameraSessionState.Idle)
            throw new InvalidOperationException($"Camera busy: {State}");

        State = CameraSessionState.CapturingPhoto;
    }

    public void BeginClipCapture(int durationMs)
    {
        Guard.Against.OutOfRange(durationMs, nameof(durationMs),
            RateLimit.CameraClipMinDurationMs, RateLimit.CameraClipMaxDurationMs);

        if (State != CameraSessionState.Idle)
            throw new InvalidOperationException($"Camera busy: {State}");

        State = CameraSessionState.CapturingClip;
    }

    public void EndCapture() => State = CameraSessionState.Idle;
}
