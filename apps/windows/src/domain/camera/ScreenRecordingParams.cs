using OpenClawWindows.Domain.Errors;
using OpenClawWindows.Domain.SharedKernel;

namespace OpenClawWindows.Domain.Camera;

public sealed record ScreenRecordingParams
{
    public string Format { get; }
    public int DurationMs { get; }
    public int Fps { get; }
    public int? ScreenIndex { get; }
    public bool IncludeAudio { get; }

    private ScreenRecordingParams(string format, int durationMs, int fps, int? screenIndex, bool includeAudio)
    {
        Format = format;
        DurationMs = durationMs;
        Fps = fps;
        ScreenIndex = screenIndex;
        IncludeAudio = includeAudio;
    }

    public static ErrorOr<ScreenRecordingParams> FromJson(string json)
    {
        Guard.Against.NullOrWhiteSpace(json, nameof(json));

        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            var format = root.TryGetProperty("format", out var f) ? f.GetString() ?? "mp4" : "mp4";
            if (format != "mp4")
                return DomainErrors.Screen.FormatInvalid();

            var durationMs = root.TryGetProperty("durationMs", out var d)
                ? d.GetInt32()
                : RateLimit.ScreenRecordDefaultDurationMs;

            if (durationMs is < RateLimit.ScreenRecordMinDurationMs or > RateLimit.ScreenRecordMaxDurationMs)
                return DomainErrors.Screen.DurationOutOfRange(durationMs);

            var fps = root.TryGetProperty("fps", out var fpsEl)
                ? fpsEl.GetInt32()
                : RateLimit.ScreenRecordDefaultFps;

            if (fps is < RateLimit.ScreenRecordMinFps or > RateLimit.ScreenRecordMaxFps)
                return DomainErrors.Screen.FpsOutOfRange(fps);

            int? screenIndex = root.TryGetProperty("screenIndex", out var si) ? si.GetInt32() : null;
            bool includeAudio = root.TryGetProperty("includeAudio", out var ia) && ia.GetBoolean();

            return new ScreenRecordingParams(format, durationMs, fps, screenIndex, includeAudio);
        }
        catch (System.Text.Json.JsonException ex)
        {
            return Error.Validation("SCR-PARSE", ex.Message);
        }
    }
}
