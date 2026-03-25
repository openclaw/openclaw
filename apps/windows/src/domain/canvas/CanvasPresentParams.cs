namespace OpenClawWindows.Domain.Canvas;

public sealed record CanvasPresentParams
{
    public string Url { get; }
    public bool Pin { get; }

    private CanvasPresentParams(string url, bool pin)
    {
        Url = url;
        Pin = pin;
    }

    public static ErrorOr<CanvasPresentParams> FromJson(string json)
    {
        Guard.Against.NullOrWhiteSpace(json, nameof(json));

        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("url", out var urlEl))
                return Error.Validation("CVS-PARSE", "Missing required field 'url'");

            var url = urlEl.GetString();
            if (string.IsNullOrWhiteSpace(url))
                return Error.Validation("CVS-PARSE", "Field 'url' must not be empty");

            var pin = root.TryGetProperty("pin", out var pinEl) && pinEl.GetBoolean();

            return new CanvasPresentParams(url, pin);
        }
        catch (System.Text.Json.JsonException ex)
        {
            return Error.Validation("CVS-PARSE", ex.Message);
        }
    }
}
