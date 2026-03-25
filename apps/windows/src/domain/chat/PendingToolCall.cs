using System.Text.Json;

namespace OpenClawWindows.Domain.Chat;

// Display-model for a tool call that is currently in flight (phase=start received, phase=result not yet).
public sealed record PendingToolCall(
    string ToolCallId,
    string Name,
    JsonElement? Args,
    double? StartedAt,
    bool? IsError)
{
    // Identifiable
    public string Id => ToolCallId;
}
