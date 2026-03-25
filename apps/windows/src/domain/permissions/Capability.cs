namespace OpenClawWindows.Domain.Permissions;

// appleScript is macOS-specific and has no Windows equivalent.
public enum Capability
{
    Notifications,
    Accessibility,
    ScreenRecording,
    Microphone,
    SpeechRecognition,
    Camera,
    Location,
}
