using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemoryCronJobsStoreTests
{
    private static InMemoryCronJobsStore Make() => new();

    private static GatewayCronJob Job(string id) => new() { Id = id };

    [Fact]
    public void Jobs_Initially_Empty()
    {
        var store = Make();
        store.Jobs.Should().BeEmpty();
    }

    [Fact]
    public void ApplyJobsSnapshot_SetsJobs()
    {
        var store = Make();
        var jobs = new[] { Job("job-1"), Job("job-2") };

        store.ApplyJobsSnapshot(jobs, null);

        store.Jobs.Should().HaveCount(2);
    }

    [Fact]
    public void ApplyJobsSnapshot_Empty_SetsStatusMessage()
    {
        var store = Make();
        store.ApplyJobsSnapshot([], null);
        store.StatusMessage.Should().Be("No cron jobs yet.");
    }

    [Fact]
    public void ApplyJobsSnapshot_NonEmpty_ClearsStatusMessage()
    {
        var store = Make();
        store.ApplyJobsSnapshot([Job("j1")], null);
        store.StatusMessage.Should().BeNull();
    }

    [Fact]
    public void ApplyJobsSnapshot_ClearsLastError()
    {
        var store = Make();
        store.SetError("previous error");

        store.ApplyJobsSnapshot([Job("j1")], null);

        store.LastError.Should().BeNull();
    }

    [Fact]
    public void ApplyJobsSnapshot_WithStatus_SetsSchedulerFields()
    {
        var store = Make();
        var status = new GatewayCronSchedulerStatus { Enabled = true, StorePath = "/data", NextWakeAtMs = 12345L };

        store.ApplyJobsSnapshot([], status);

        store.SchedulerEnabled.Should().BeTrue();
        store.SchedulerStorePath.Should().Be("/data");
        store.SchedulerNextWakeAtMs.Should().Be(12345L);
    }

    [Fact]
    public void ApplyJobsSnapshot_FiresStateChanged()
    {
        var store = Make();
        var fired = 0;
        store.StateChanged += (_, _) => fired++;

        store.ApplyJobsSnapshot([], null);

        fired.Should().Be(1);
    }

    [Fact]
    public void SetError_SetsLastError()
    {
        var store = Make();
        store.SetError("rpc timeout");
        store.LastError.Should().Be("rpc timeout");
    }

    [Fact]
    public void SetJobsLoading_SetsFlag()
    {
        var store = Make();
        store.SetJobsLoading(true);
        store.IsLoadingJobs.Should().BeTrue();
    }

    [Fact]
    public void SetRunsLoading_SetsFlag()
    {
        var store = Make();
        store.SetRunsLoading(true);
        store.IsLoadingRuns.Should().BeTrue();
    }

    // ── Refresh signals ───────────────────────────────────────────────────────

    [Fact]
    public void ConsumeRefreshSignal_BeforeSignal_ReturnsFalse()
    {
        var store = Make();
        store.ConsumeRefreshSignal().Should().BeFalse();
    }

    [Fact]
    public void SignalRefresh_ThenConsume_ReturnsTrue()
    {
        var store = Make();
        store.SignalRefresh();
        store.ConsumeRefreshSignal().Should().BeTrue();
    }

    [Fact]
    public void ConsumeRefreshSignal_ConsumesOnce()
    {
        var store = Make();
        store.SignalRefresh();
        store.ConsumeRefreshSignal(); // first consume
        store.ConsumeRefreshSignal().Should().BeFalse(); // second should be false
    }

    [Fact]
    public void HandleCronEvent_Finished_SelectedJob_SetsRunsSignal()
    {
        var store = Make();
        store.SelectedJobId = "job-1";

        store.HandleCronEvent("job-1", "finished");

        var (pending, jobId) = store.ConsumeRunsRefreshSignal();
        pending.Should().BeTrue();
        jobId.Should().Be("job-1");
    }

    [Fact]
    public void HandleCronEvent_Finished_OtherJob_NoRunsSignal()
    {
        var store = Make();
        store.SelectedJobId = "job-2";

        store.HandleCronEvent("job-1", "finished");

        var (pending, _) = store.ConsumeRunsRefreshSignal();
        pending.Should().BeFalse();
    }

    [Fact]
    public void HandleCronEvent_NonFinished_NoRunsSignal()
    {
        var store = Make();
        store.SelectedJobId = "job-1";

        store.HandleCronEvent("job-1", "started");

        var (pending, _) = store.ConsumeRunsRefreshSignal();
        pending.Should().BeFalse();
    }

    [Fact]
    public void ConsumeRunsRefreshSignal_ConsumesOnce()
    {
        var store = Make();
        store.SelectedJobId = "job-1";
        store.HandleCronEvent("job-1", "finished");
        store.ConsumeRunsRefreshSignal(); // first consume
        var (pending, _) = store.ConsumeRunsRefreshSignal(); // second should be false
        pending.Should().BeFalse();
    }
}
