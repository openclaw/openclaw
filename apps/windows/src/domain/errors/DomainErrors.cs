using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Errors;

/// <summary>
/// Domain error factory using ErrorOr pattern.
/// Canonical error strings from ErrorCodes match macOS protocol exactly.
/// </summary>
public static class DomainErrors
{
    public static class Gateway
    {
        public static Error InvalidClientId() =>
            Error.Validation("GW-001", "clientId must equal 'openclaw-control-ui'");

        public static Error InvalidUri(string uri) =>
            Error.Validation("GW-002", $"Gateway URI must use ws:// or wss://: {uri}");

        public static Error NotConnected() =>
            Error.Failure("GW-003", "Gateway not connected");

        public static Error InvalidStateTransition(string from, string to) =>
            Error.Failure("GW-004", $"Invalid gateway state transition: {from} → {to}");
    }

    public static class Camera
    {
        public static Error PermissionMissing() =>
            Error.Failure("CAM-001", ErrorCodes.PermissionMissingCamera);

        public static Error Unavailable() =>
            Error.Failure("CAM-002", ErrorCodes.CameraUnavailable);

        public static Error ClipFormatInvalid() =>
            Error.Failure("CAM-003", ErrorCodes.ClipFormatInvalid);

        public static Error DurationOutOfRange(int ms) =>
            Error.Validation("CAM-004", $"Duration {ms}ms out of range [{RateLimit.CameraClipMinDurationMs}..{RateLimit.CameraClipMaxDurationMs}]");

        public static Error NoFramesCaptured() =>
            Error.Failure("CAM-005", ErrorCodes.NoFramesCaptured);
    }

    public static class Screen
    {
        public static Error FormatInvalid() =>
            Error.Failure("SCR-001", ErrorCodes.ScreenFormatInvalid);

        public static Error InvalidIndex(int n) =>
            Error.Failure("SCR-002", string.Format(ErrorCodes.InvalidScreenIndex, n));

        public static Error NoDisplaysAvailable() =>
            Error.Failure("SCR-003", ErrorCodes.NoDisplaysAvailable);

        public static Error NoFramesCaptured() =>
            Error.Failure("SCR-004", ErrorCodes.NoFramesCaptured);

        public static Error FpsOutOfRange(int fps) =>
            Error.Validation("SCR-005", $"FPS {fps} out of range [{RateLimit.ScreenRecordMinFps}..{RateLimit.ScreenRecordMaxFps}]");

        public static Error DurationOutOfRange(int ms) =>
            Error.Validation("SCR-006", $"Duration {ms}ms out of range [{RateLimit.ScreenRecordMinDurationMs}..{RateLimit.ScreenRecordMaxDurationMs}]");
    }

    public static class Microphone
    {
        public static Error PermissionMissing() =>
            Error.Failure("MIC-001", ErrorCodes.PermissionMissingMicrophone);
    }

    public static class ExecApprovals
    {
        public static Error NotApproved(string command) =>
            Error.Failure("EXEC-001", $"Command not approved for execution: {command}");

        public static Error CommandBlocked(string command) =>
            Error.Failure("EXEC-002", $"Command blocked by policy: {command}");

        public static Error IpcNotAvailable() =>
            Error.Failure("EXEC-003", "ExecApproval IPC pipe not available");
    }

    public static class Canvas
    {
        public static Error InvalidA2UIAction(string actionType) =>
            Error.Validation("CVS-001", $"actionType must start with 'a2ui.': {actionType}");

        public static Error NotVisible() =>
            Error.Failure("CVS-002", "Canvas window is not visible");

        public static Error InvalidUrl(string url) =>
            Error.Validation("CVS-003", $"Invalid canvas URL: {url}");
    }

    public static class Pairing
    {
        public static Error KeyGenerationFailed(string reason) =>
            Error.Failure("PAR-001", $"Ed25519 key generation failed: {reason}");

        public static Error NotPaired() =>
            Error.Failure("PAR-002", "Device is not paired with gateway");

        public static Error InvalidStateTransition(string from, string to) =>
            Error.Failure("PAR-003", $"Invalid pairing state transition: {from} → {to}");
    }

    public static class VoiceWake
    {
        public static Error SensitivityOutOfRange(float v) =>
            Error.Validation("VW-001", $"Sensitivity {v} must be in [0.0..1.0]");

        public static Error EngineNotAvailable() =>
            Error.Failure("VW-002", "Voice wake hotword detection is not yet available on this platform.");
    }

    public static class Settings
    {
        public static Error AppDataPathInvalid(string path) =>
            Error.Validation("SET-001", $"AppDataPath must be non-empty and rooted: '{path}'");

        public static Error SensitivityOutOfRange(float v) =>
            Error.Validation("SET-002", $"VoiceWakeSensitivity {v} must be in [0.0..1.0]");

        public static Error SaveFailed(string reason) =>
            Error.Failure("SET-003", $"Settings save failed: {reason}");
    }

    public static class Onboarding
    {
        public static Error GatewayNotValidated() =>
            Error.Failure("ONB-001", "Gateway endpoint must be validated before completing onboarding");

        public static Error StepRegression(int current, int requested) =>
            Error.Failure("ONB-002", $"Onboarding steps can only advance forward (current: {current}, requested: {requested})");
    }
}
