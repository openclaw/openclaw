namespace OpenClawWindows.Domain.AgentEvents;

// stream values: "job" | "tool" | "assistant".
internal sealed record AgentEvent(
    string RunId,
    int Seq,
    string Stream,
    double TsMs,
    string DataJson,
    string? Summary);
