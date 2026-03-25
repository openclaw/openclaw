using System.Text.Json;
using OpenClawWindows.Domain.Cron;

namespace OpenClawWindows.Tests.Unit.Domain.Cron;

public sealed class CronModelsTests
{
    private static readonly JsonSerializerOptions Opts = new();

    // ── CronSchedule ──────────────────────────────────────────────────────────

    [Fact]
    public void ScheduleAt_EncodesAndDecodes()
    {
        // Mirrors scheduleAtEncodesAndDecodes in Swift
        var schedule = new CronSchedule.At("2026-02-03T18:00:00Z");
        var json = JsonSerializer.Serialize<CronSchedule>(schedule, Opts);
        var decoded = JsonSerializer.Deserialize<CronSchedule>(json, Opts);
        decoded.Should().Be(schedule);
    }

    [Fact]
    public void ScheduleAt_DecodesLegacyAtMs()
    {
        // Mirrors scheduleAtDecodesLegacyAtMs — atMs epoch-ms → ISO string
        const string json = """{"kind":"at","atMs":1700000000000}""";
        var decoded = JsonSerializer.Deserialize<CronSchedule>(json, Opts);
        var at = decoded.Should().BeOfType<CronSchedule.At>().Subject;
        at.AtValue.Should().StartWith("2023-");
    }

    [Fact]
    public void ScheduleEvery_EncodesAndDecodesWithAnchor()
    {
        // Mirrors scheduleEveryEncodesAndDecodesWithAnchor
        var schedule = new CronSchedule.Every(5000, 10000);
        var json = JsonSerializer.Serialize<CronSchedule>(schedule, Opts);
        var decoded = JsonSerializer.Deserialize<CronSchedule>(json, Opts);
        decoded.Should().Be(schedule);
    }

    [Fact]
    public void ScheduleCron_EncodesAndDecodesWithTimezone()
    {
        // Mirrors scheduleCronEncodesAndDecodesWithTimezone
        var schedule = new CronSchedule.CronExpr("*/5 * * * *", "Europe/Vienna");
        var json = JsonSerializer.Serialize<CronSchedule>(schedule, Opts);
        var decoded = JsonSerializer.Deserialize<CronSchedule>(json, Opts);
        decoded.Should().Be(schedule);
    }

    [Fact]
    public void Schedule_DecodesRejectsUnknownKind()
    {
        // Mirrors scheduleDecodeRejectsUnknownKind
        const string json = """{"kind":"wat","at":"2026-02-03T18:00:00Z"}""";
        var act = () => JsonSerializer.Deserialize<CronSchedule>(json, Opts);
        act.Should().Throw<JsonException>();
    }

    // ── CronPayload ───────────────────────────────────────────────────────────

    [Fact]
    public void PayloadAgentTurn_EncodesAndDecodes()
    {
        // Mirrors payloadAgentTurnEncodesAndDecodes
        var payload = new CronPayload.AgentTurn(
            Message: "hello",
            Thinking: "low",
            TimeoutSeconds: 15,
            Deliver: true,
            Channel: "whatsapp",
            To: "+15551234567",
            BestEffortDeliver: false);

        var json = JsonSerializer.Serialize<CronPayload>(payload, Opts);
        var decoded = JsonSerializer.Deserialize<CronPayload>(json, Opts);
        decoded.Should().Be(payload);
    }

    [Fact]
    public void PayloadAgentTurn_DecodesProviderAliasForChannel()
    {
        // The "provider" key is a legacy alias for "channel" (mirrors Swift fallback)
        const string json = """{"kind":"agentTurn","message":"hi","provider":"openai"}""";
        var decoded = JsonSerializer.Deserialize<CronPayload>(json, Opts);
        var at = decoded.Should().BeOfType<CronPayload.AgentTurn>().Subject;
        at.Channel.Should().Be("openai");
    }

    [Fact]
    public void Payload_DecodesRejectsUnknownKind()
    {
        // Mirrors payloadDecodeRejectsUnknownKind
        const string json = """{"kind":"wat","text":"hello"}""";
        var act = () => JsonSerializer.Deserialize<CronPayload>(json, Opts);
        act.Should().Throw<JsonException>();
    }

    // ── CronJob ───────────────────────────────────────────────────────────────

    [Fact]
    public void Job_EncodesAndDecodesDeleteAfterRun()
    {
        // Mirrors jobEncodesAndDecodesDeleteAfterRun
        var job = MakeJob("One-shot", "ping", deleteAfterRun: true);
        var json = JsonSerializer.Serialize(job, Opts);
        var decoded = JsonSerializer.Deserialize<CronJob>(json, Opts);
        decoded!.DeleteAfterRun.Should().BeTrue();
    }

    [Fact]
    public void Job_DisplayName_TrimsWhitespaceAndFallsBack()
    {
        // Mirrors displayNameTrimsWhitespaceAndFallsBack
        var trimmed = MakeJob("  hello  ", "hi");
        trimmed.DisplayName.Should().Be("hello");

        var unnamed = MakeJob("   ", "hi");
        unnamed.DisplayName.Should().Be("Untitled job");
    }

    [Fact]
    public void Job_NextRunDateAndLastRunDate_DeriveFromState()
    {
        // Mirrors nextRunDateAndLastRunDateDeriveFromState
        // 1_700_000_000_000 ms → 1_700_000_000 s epoch
        var state = new CronJobState
        {
            NextRunAtMs = 1_700_000_000_000L,
            LastRunAtMs = 1_700_000_050_000L
        };
        var job = MakeJob("t", "hi", state: state);

        job.NextRunDate.Should().Be(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000L));
        job.LastRunDate.Should().Be(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_050_000L));
    }

    // ── CronRunLogEntry ───────────────────────────────────────────────────────

    [Fact]
    public void RunLogEntry_Id_IsJobIdDashTs()
    {
        var entry = new CronRunLogEntry { JobId = "job-1", Ts = 123456, Action = "finished" };
        entry.Id.Should().Be("job-1-123456");
    }

    [Fact]
    public void RunLogEntry_Date_DerivesFromTs()
    {
        var entry = new CronRunLogEntry { JobId = "x", Ts = 1_700_000_000_000L, Action = "finished" };
        entry.Date.Should().Be(DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000L));
    }

    [Fact]
    public void RunLogEntry_RunDate_IsNullWhenRunAtMsAbsent()
    {
        var entry = new CronRunLogEntry { JobId = "x", Ts = 1, Action = "a" };
        entry.RunDate.Should().BeNull();
    }

    // ── CronSchedule helpers ──────────────────────────────────────────────────

    [Theory]
    [InlineData("2026-02-03T18:00:00Z")]
    [InlineData("2026-02-03T18:00:00.123Z")]
    [InlineData("2026-02-03T18:00:00+02:00")]
    public void ParseAtDate_ParsesValidIso8601(string input)
    {
        CronSchedule.ParseAtDate(input).Should().NotBeNull();
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not-a-date")]
    public void ParseAtDate_ReturnsNullForInvalidInput(string input)
    {
        CronSchedule.ParseAtDate(input).Should().BeNull();
    }

    [Fact]
    public void FormatIsoDate_ProducesUtcZSuffix()
    {
        var date = new DateTimeOffset(2026, 2, 3, 18, 0, 0, TimeSpan.Zero);
        CronSchedule.FormatIsoDate(date).Should().Be("2026-02-03T18:00:00Z");
    }

    // ── Enum serialization ────────────────────────────────────────────────────

    [Theory]
    [InlineData(CronSessionTarget.Main, "\"main\"")]
    [InlineData(CronSessionTarget.Isolated, "\"isolated\"")]
    public void CronSessionTarget_SerializesToExpectedString(CronSessionTarget value, string expected)
    {
        JsonSerializer.Serialize(value, Opts).Should().Be(expected);
    }

    [Theory]
    [InlineData(CronWakeMode.Now, "\"now\"")]
    [InlineData(CronWakeMode.NextHeartbeat, "\"next-heartbeat\"")]
    public void CronWakeMode_SerializesToExpectedString(CronWakeMode value, string expected)
    {
        JsonSerializer.Serialize(value, Opts).Should().Be(expected);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static CronJob MakeJob(
        string name,
        string payloadText,
        bool? deleteAfterRun = null,
        CronJobState? state = null) => new()
    {
        Id = "x",
        Name = name,
        Enabled = true,
        DeleteAfterRun = deleteAfterRun,
        CreatedAtMs = 0,
        UpdatedAtMs = 0,
        Schedule = new CronSchedule.At("2026-02-03T18:00:00Z"),
        SessionTarget = CronSessionTarget.Main,
        WakeMode = CronWakeMode.Now,
        Payload = new CronPayload.SystemEvent(payloadText),
        State = state ?? new CronJobState()
    };
}
