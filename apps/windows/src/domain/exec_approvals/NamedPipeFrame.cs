using System.Text.Json;

namespace OpenClawWindows.Domain.ExecApprovals;

// IPC frame for exec approval pipe — 4-byte LE uint32 length prefix + UTF-8 JSON body.
public sealed record NamedPipeFrame
{
    public string PayloadJson { get; }
    public string CorrelationId { get; }
    public string MessageType { get; }  // "approval_request" | "approval_response"

    private NamedPipeFrame(string payloadJson, string correlationId, string messageType)
    {
        PayloadJson = payloadJson;
        CorrelationId = correlationId;
        MessageType = messageType;
    }

    public static NamedPipeFrame ApprovalRequest(string commandJson, string correlationId)
    {
        Guard.Against.NullOrWhiteSpace(commandJson, nameof(commandJson));
        Guard.Against.NullOrWhiteSpace(correlationId, nameof(correlationId));

        // Validate JSON before sending over pipe
        JsonDocument.Parse(commandJson).Dispose();

        return new(commandJson, correlationId, "approval_request");
    }

    public static NamedPipeFrame ApprovalResponse(bool approved, string correlationId)
    {
        Guard.Against.NullOrWhiteSpace(correlationId, nameof(correlationId));

        var json = JsonSerializer.Serialize(new { approved, correlationId });
        return new(json, correlationId, "approval_response");
    }

    // Framing: 4-byte LE length prefix + UTF-8 JSON body (OQ-001)
    public byte[] ToWireBytes()
    {
        var body = System.Text.Encoding.UTF8.GetBytes(PayloadJson);
        var length = BitConverter.GetBytes((uint)body.Length);  // 4-byte LE uint32
        var wire = new byte[4 + body.Length];
        Array.Copy(length, wire, 4);
        Array.Copy(body, 0, wire, 4, body.Length);
        return wire;
    }
}
