using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.ExecApprovals;

[JsonConverter(typeof(JsonStringEnumConverter<ExecApprovalDecision>))]
public enum ExecApprovalDecision
{
    [JsonStringEnumMemberName("allow-once")]
    AllowOnce,
    [JsonStringEnumMemberName("allow-always")]
    AllowAlways,
    [JsonStringEnumMemberName("deny")]
    Deny,
}
