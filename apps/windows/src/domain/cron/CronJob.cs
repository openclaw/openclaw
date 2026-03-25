using System.Text.Json.Serialization;

namespace OpenClawWindows.Domain.Cron;

public sealed class CronJobState
{
    [JsonPropertyName("nextRunAtMs")]   public long? NextRunAtMs { get; init; }
    [JsonPropertyName("runningAtMs")]   public long? RunningAtMs { get; init; }
    [JsonPropertyName("lastRunAtMs")]   public long? LastRunAtMs { get; init; }
    [JsonPropertyName("lastStatus")]    public string? LastStatus { get; init; }
    [JsonPropertyName("lastError")]     public string? LastError { get; init; }
    [JsonPropertyName("lastDurationMs")] public int? LastDurationMs { get; init; }
}

public sealed class CronJob
{
    [JsonPropertyName("id")]            public string Id { get; init; } = string.Empty;
    [JsonPropertyName("agentId")]       public string? AgentId { get; init; }
    [JsonPropertyName("name")]          public string Name { get; init; } = string.Empty;
    [JsonPropertyName("description")]   public string? Description { get; init; }
    [JsonPropertyName("enabled")]       public bool Enabled { get; init; }
    [JsonPropertyName("deleteAfterRun")] public bool? DeleteAfterRun { get; init; }
    [JsonPropertyName("createdAtMs")]   public long CreatedAtMs { get; init; }
    [JsonPropertyName("updatedAtMs")]   public long UpdatedAtMs { get; init; }
    [JsonPropertyName("schedule")]      public CronSchedule Schedule { get; init; } = new CronSchedule.At(string.Empty);
    [JsonPropertyName("sessionTarget")] public CronSessionTarget SessionTarget { get; init; }
    [JsonPropertyName("wakeMode")]      public CronWakeMode WakeMode { get; init; }
    [JsonPropertyName("payload")]       public CronPayload Payload { get; init; } = new CronPayload.SystemEvent(string.Empty);
    [JsonPropertyName("delivery")]      public CronDelivery? Delivery { get; init; }
    [JsonPropertyName("state")]         public CronJobState State { get; init; } = new();

    // trims whitespace, falls back to "Untitled job".
    [JsonIgnore]
    public string DisplayName =>
        string.IsNullOrWhiteSpace(Name) ? "Untitled job" : Name.Trim();

    // epoch-ms / 1000 → DateTimeOffset.
    [JsonIgnore]
    public DateTimeOffset? NextRunDate => State.NextRunAtMs.HasValue
        ? DateTimeOffset.FromUnixTimeMilliseconds(State.NextRunAtMs.Value) : null;

    // epoch-ms / 1000 → DateTimeOffset.
    [JsonIgnore]
    public DateTimeOffset? LastRunDate => State.LastRunAtMs.HasValue
        ? DateTimeOffset.FromUnixTimeMilliseconds(State.LastRunAtMs.Value) : null;
}

public sealed class CronEvent
{
    [JsonPropertyName("jobId")]        public string JobId { get; init; } = string.Empty;
    [JsonPropertyName("action")]       public string Action { get; init; } = string.Empty;
    [JsonPropertyName("runAtMs")]      public long? RunAtMs { get; init; }
    [JsonPropertyName("durationMs")]   public int? DurationMs { get; init; }
    [JsonPropertyName("status")]       public string? Status { get; init; }
    [JsonPropertyName("error")]        public string? Error { get; init; }
    [JsonPropertyName("summary")]      public string? Summary { get; init; }
    [JsonPropertyName("nextRunAtMs")]  public long? NextRunAtMs { get; init; }
}

public sealed class CronRunLogEntry
{
    [JsonPropertyName("ts")]           public long Ts { get; init; }
    [JsonPropertyName("jobId")]        public string JobId { get; init; } = string.Empty;
    [JsonPropertyName("action")]       public string Action { get; init; } = string.Empty;
    [JsonPropertyName("status")]       public string? Status { get; init; }
    [JsonPropertyName("error")]        public string? Error { get; init; }
    [JsonPropertyName("summary")]      public string? Summary { get; init; }
    [JsonPropertyName("runAtMs")]      public long? RunAtMs { get; init; }
    [JsonPropertyName("durationMs")]   public int? DurationMs { get; init; }
    [JsonPropertyName("nextRunAtMs")]  public long? NextRunAtMs { get; init; }

    // "{jobId}-{ts}".
    [JsonIgnore]
    public string Id => $"{JobId}-{Ts}";

    // epoch-ms / 1000 → DateTimeOffset.
    [JsonIgnore]
    public DateTimeOffset Date => DateTimeOffset.FromUnixTimeMilliseconds(Ts);

    // epoch-ms / 1000 → DateTimeOffset?.
    [JsonIgnore]
    public DateTimeOffset? RunDate => RunAtMs.HasValue
        ? DateTimeOffset.FromUnixTimeMilliseconds(RunAtMs.Value) : null;
}

public sealed class CronListResponse
{
    [JsonPropertyName("jobs")] public List<CronJob> Jobs { get; init; } = [];
}

public sealed class CronRunsResponse
{
    [JsonPropertyName("entries")] public List<CronRunLogEntry> Entries { get; init; } = [];
}
