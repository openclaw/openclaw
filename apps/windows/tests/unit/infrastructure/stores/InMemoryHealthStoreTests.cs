using OpenClawWindows.Domain.Health;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemoryHealthStoreTests
{
    private static InMemoryHealthStore Make() => new();

    private static HealthSnapshot MakeSnapshot(
        bool? linked = null, bool? probeOk = null, double authAgeMs = 0) =>
        new(Ok: linked == true && (probeOk ?? true),
            Ts: 1_700_000_000_000,
            DurationMs: 50,
            Channels: new Dictionary<string, ChannelSummary>
            {
                ["claude"] = new ChannelSummary(
                    Configured: true,
                    Linked: linked,
                    AuthAgeMs: authAgeMs,
                    Probe: probeOk.HasValue ? new ChannelProbe(Ok: probeOk, null, null, null, null, null) : null,
                    LastProbeAt: null)
            },
            ChannelOrder: ["claude"],
            ChannelLabels: null,
            HeartbeatSeconds: 30,
            Sessions: new HealthSessions("/path", 1, []));

    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void State_Initially_Unknown()
    {
        var store = Make();
        store.State.Should().BeOfType<HealthState.Unknown>();
    }

    [Fact]
    public void SummaryLine_Initially_Pending()
    {
        var store = Make();
        store.SummaryLine.Should().Contain("pending");
    }

    // ── Apply ─────────────────────────────────────────────────────────────────

    [Fact]
    public void Apply_LinkedAndProbeOk_StateIsOk()
    {
        var store = Make();
        store.Apply(MakeSnapshot(linked: true, probeOk: true));
        store.State.Should().BeOfType<HealthState.Ok>();
    }

    [Fact]
    public void Apply_LinkedButProbeFailed_StateDegraded()
    {
        var store = Make();
        store.Apply(MakeSnapshot(linked: true, probeOk: false));
        store.State.Should().BeOfType<HealthState.Degraded>();
    }

    [Fact]
    public void Apply_NotLinked_NoFallback_LinkingNeeded()
    {
        var store = Make();
        store.Apply(MakeSnapshot(linked: false));
        store.State.Should().BeOfType<HealthState.LinkingNeeded>();
    }

    [Fact]
    public void Apply_SetsLastSuccess()
    {
        var store = Make();
        var before = DateTimeOffset.UtcNow;

        store.Apply(MakeSnapshot(linked: true, probeOk: true));

        store.LastSuccess.Should().NotBeNull();
        store.LastSuccess!.Value.Should().BeOnOrAfter(before);
    }

    [Fact]
    public void Apply_ClearsLastError()
    {
        var store = Make();
        store.SetError("previous error");

        store.Apply(MakeSnapshot(linked: true, probeOk: true));

        store.LastError.Should().BeNull();
    }

    [Fact]
    public void Apply_ClearsRefreshing()
    {
        var store = Make();
        store.SetRefreshing(true);

        store.Apply(MakeSnapshot(linked: true, probeOk: true));

        store.IsRefreshing.Should().BeFalse();
    }

    [Fact]
    public void Apply_FiresHealthChanged()
    {
        var store = Make();
        var fired = 0;
        store.HealthChanged += (_, _) => fired++;

        store.Apply(MakeSnapshot(linked: true, probeOk: true));

        fired.Should().Be(1);
    }

    // ── SetError ─────────────────────────────────────────────────────────────

    [Fact]
    public void SetError_StateBecomesDegraded()
    {
        var store = Make();
        store.SetError("timeout");
        store.State.Should().BeOfType<HealthState.Degraded>();
    }

    [Fact]
    public void SetError_SetsLastError()
    {
        var store = Make();
        store.SetError("connection refused");
        store.LastError.Should().Be("connection refused");
    }

    [Fact]
    public void SetError_FiresHealthChanged()
    {
        var store = Make();
        var fired = 0;
        store.HealthChanged += (_, _) => fired++;

        store.SetError("error");

        fired.Should().Be(1);
    }

    // ── SetRefreshing ─────────────────────────────────────────────────────────

    [Fact]
    public void SetRefreshing_True_SummaryLineContainsRunning()
    {
        var store = Make();
        store.SetRefreshing(true);
        store.SummaryLine.Should().Contain("running");
    }

    // ── SummaryLine / MsToAge ─────────────────────────────────────────────────

    [Fact]
    public void SummaryLine_Linked_WithRecentAuth_ShowsJustNow()
    {
        var store = Make();
        // authAgeMs < 60000 → "just now"
        store.Apply(MakeSnapshot(linked: true, probeOk: true, authAgeMs: 30_000));
        store.SummaryLine.Should().Contain("just now");
    }

    [Fact]
    public void SummaryLine_Linked_Auth90s_ShowsMinutes()
    {
        var store = Make();
        store.Apply(MakeSnapshot(linked: true, probeOk: true, authAgeMs: 90_000)); // 1.5 min → 2m
        store.SummaryLine.Should().Contain("m");
    }
}
