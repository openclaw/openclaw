using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.ExecApprovals;

[JsonConverter(typeof(JsonStringEnumConverter<ExecSecurity>))]
public enum ExecSecurity
{
    [JsonStringEnumMemberName("deny")]
    Deny,
    [JsonStringEnumMemberName("allowlist")]
    Allowlist,
    [JsonStringEnumMemberName("full")]
    Full,
}
