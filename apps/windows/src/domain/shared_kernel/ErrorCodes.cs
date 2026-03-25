namespace OpenClawWindows.Domain.SharedKernel;

// Error strings match macOS exactly — gateway protocol requires identical text.
public static class ErrorCodes
{
    public const string ScreenFormatInvalid   = "INVALID_REQUEST: screen format must be mp4";
    public const string ClipFormatInvalid     = "INVALID_REQUEST: camera clip format must be mp4";
    public const string NoDisplaysAvailable   = "No displays available for screen recording";
    public const string NoFramesCaptured      = "No frames captured";
    public const string PermissionMissingCamera     = "PERMISSION_MISSING: camera";
    public const string PermissionMissingMicrophone = "PERMISSION_MISSING: microphone";
    public const string CameraUnavailable     = "Camera unavailable";

    // screen index — formatted at call site: string.Format(InvalidScreenIndex, N)
    public const string InvalidScreenIndex    = "Invalid screen index {0}";
}
