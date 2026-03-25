namespace OpenClawWindows.Domain.Canvas;

public sealed record JavaScriptEvalResult
{
    public bool Success { get; }
    public string? ResultJson { get; }
    public string? Error { get; }

    private JavaScriptEvalResult(bool success, string? resultJson, string? error)
    {
        Success = success;
        ResultJson = resultJson;
        Error = error;
    }

    public static JavaScriptEvalResult FromSuccess(string? resultJson) =>
        new(true, resultJson, null);

    public static JavaScriptEvalResult FromFailure(string error)
    {
        Guard.Against.NullOrWhiteSpace(error, nameof(error));
        return new(false, null, error);
    }
}
