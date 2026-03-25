using OpenClawWindows.Domain.Errors;

namespace OpenClawWindows.Domain.Canvas;

public sealed record A2UIAction
{
    public string ActionType { get; }
    public string? TargetSelector { get; }
    public string? Value { get; }
    public System.Text.Json.JsonElement? Extra { get; }

    private A2UIAction(string actionType, string? targetSelector, string? value,
        System.Text.Json.JsonElement? extra)
    {
        ActionType = actionType;
        TargetSelector = targetSelector;
        Value = value;
        Extra = extra;
    }

    public static ErrorOr<A2UIAction> FromJson(string json)
    {
        Guard.Against.NullOrWhiteSpace(json, nameof(json));

        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (!root.TryGetProperty("actionType", out var actionTypeEl))
                return Error.Validation("A2UI-PARSE", "Missing required field 'actionType'");

            var actionType = actionTypeEl.GetString() ?? "";

            // actionType must start with 'a2ui.' — gateway contract invariant
            if (!actionType.StartsWith("a2ui.", StringComparison.Ordinal))
                return DomainErrors.Canvas.InvalidA2UIAction(actionType);

            var targetSelector = root.TryGetProperty("targetSelector", out var ts) ? ts.GetString() : null;
            var value = root.TryGetProperty("value", out var v) ? v.GetString() : null;
            System.Text.Json.JsonElement? extra = root.TryGetProperty("extra", out var ex) ? ex : null;

            return new A2UIAction(actionType, targetSelector, value, extra);
        }
        catch (System.Text.Json.JsonException ex)
        {
            return Error.Validation("A2UI-PARSE", ex.Message);
        }
    }
}
