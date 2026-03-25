using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.ExecApprovals;

[JsonConverter(typeof(JsonStringEnumConverter<ExecAsk>))]
public enum ExecAsk
{
    [JsonStringEnumMemberName("off")]
    Off,
    [JsonStringEnumMemberName("on-miss")]
    OnMiss,
    [JsonStringEnumMemberName("always")]
    Always,
}
