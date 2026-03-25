namespace OpenClawWindows.Domain.Chat;

// Display-model for a single chat message — decoded from the gateway chat.history payload.
public sealed record ChatMessageRow(
    Guid Id,
    string Role,
    string Text,
    bool IsUser,
    bool IsAssistant,
    bool IsToolResult,
    string? ToolName,
    DateTimeOffset? Timestamp,
    IReadOnlyList<InlineImageData>? InlineImages = null)
{
    public bool HasInlineImages => InlineImages?.Count > 0;
}
