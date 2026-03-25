namespace OpenClawWindows.Domain.Chat;

// Display-model for an attachment queued in the composer before sending.
public sealed record PendingAttachment(
    Guid Id,
    string FileName,
    string MimeType,
    byte[] Data)
{
    // base64 content for the gateway payload.
    public string ContentBase64 => Convert.ToBase64String(Data);

    public bool IsImage => MimeType.StartsWith("image/", StringComparison.OrdinalIgnoreCase);
}
