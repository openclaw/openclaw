namespace OpenClawWindows.Domain.TalkMode;

// Optional per-session configuration for talk mode
// All fields optional; null means "use system default".
public sealed record TalkModeConfig(
    string? Language = null,         // BCP-47 locale, e.g. "en-US"
    float? SilenceThresholdDb = null // VAD silence gate in dBFS
);
