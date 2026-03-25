namespace OpenClawWindows.Domain.Chat;

// Carries a single base64-decoded inline image extracted from a chat message.
public sealed record InlineImageData(string Label, byte[]? Bytes);
