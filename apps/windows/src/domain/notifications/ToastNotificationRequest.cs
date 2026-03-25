using System.Text.Json;

namespace OpenClawWindows.Domain.Notifications;

// system.notify request.
public sealed record ToastNotificationRequest
{
    public string Title { get; }
    public string Body { get; }
    public string? ActionLabel { get; }
    public string? ActionUrl { get; }
    public int? TimeoutMs { get; }

    private ToastNotificationRequest(string title, string body, string? actionLabel,
        string? actionUrl, int? timeoutMs)
    {
        Title = title;
        Body = body;
        ActionLabel = actionLabel;
        ActionUrl = actionUrl;
        TimeoutMs = timeoutMs;
    }

    public static ErrorOr<ToastNotificationRequest> Create(string title, string body,
        string? actionLabel, string? actionUrl, int? timeoutMs)
    {
        Guard.Against.NullOrWhiteSpace(title, nameof(title));
        Guard.Against.NullOrWhiteSpace(body, nameof(body));

        return new ToastNotificationRequest(title, body, actionLabel, actionUrl, timeoutMs);
    }

    public static ErrorOr<ToastNotificationRequest> FromJson(string json)
    {
        Guard.Against.NullOrWhiteSpace(json, nameof(json));

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var title = root.TryGetProperty("title", out var t) ? t.GetString() : null;
            var body = root.TryGetProperty("body", out var b) ? b.GetString() : null;

            if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(body))
                return Error.Validation("NOTIFY-PARSE", "Fields 'title' and 'body' are required");

            var actionLabel = root.TryGetProperty("actionLabel", out var al) ? al.GetString() : null;
            var actionUrl = root.TryGetProperty("actionUrl", out var au) ? au.GetString() : null;
            int? timeoutMs = root.TryGetProperty("timeoutMs", out var tm) ? tm.GetInt32() : null;

            return Create(title, body, actionLabel, actionUrl, timeoutMs);
        }
        catch (JsonException ex)
        {
            return Error.Validation("NOTIFY-PARSE", ex.Message);
        }
    }
}
