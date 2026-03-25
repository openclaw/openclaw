namespace OpenClawWindows.Domain.SharedKernel;

// Canonical rate limits — Windows MUST match exactly.
public static class RateLimit
{
    // Tunables
    public const int ScreenRecordMinDurationMs = 250;
    public const int ScreenRecordMaxDurationMs = 60_000;
    public const int ScreenRecordDefaultDurationMs = 10_000;
    public const int ScreenRecordMinFps = 1;
    public const int ScreenRecordMaxFps = 60;
    public const int ScreenRecordDefaultFps = 10;

    public const int CameraClipMinDurationMs = 250;
    public const int CameraClipMaxDurationMs = 60_000;
    public const int CameraClipDefaultDurationMs = 3_000;

    public const int CameraSnapMinDelayMs = 0;
    public const int CameraSnapMaxDelayMs = 10_000;
    public const int CameraSnapDefaultDelayMs = 0;
}
