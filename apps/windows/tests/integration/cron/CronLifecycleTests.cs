using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.Cron;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway.Events;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Integration.Cron;

// Integration: InMemoryCronJobsStore + RefreshCronJobsOnConnectHandler + cron command handlers.
// Verifies that gateway reconnect signals a store refresh, and that cron RPC commands
// propagate correctly through the handler layer.
public sealed class CronLifecycleTests
{
    private readonly InMemoryCronJobsStore _store = new();
    private readonly IGatewayRpcChannel _rpc = Substitute.For<IGatewayRpcChannel>();

    // ── Store state management ────────────────────────────────────────────────

    [Fact]
    public void Store_Initially_HasNoJobs()
    {
        _store.Jobs.Should().BeEmpty();
        _store.LastError.Should().BeNull();
    }

    [Fact]
    public void Store_ApplyJobsSnapshot_UpdatesJobs()
    {
        var jobs = new List<GatewayCronJob>
        {
            new() { Id = "job-1", Name = "daily-cleanup", Enabled = true },
            new() { Id = "job-2", Name = "weekly-report", Enabled = false },
        };

        _store.ApplyJobsSnapshot(jobs, null);

        _store.Jobs.Should().HaveCount(2);
        _store.Jobs[0].Id.Should().Be("job-1");
        _store.LastError.Should().BeNull();
    }

    [Fact]
    public void Store_ApplyEmptySnapshot_SetsStatusMessage()
    {
        _store.ApplyJobsSnapshot([], null);

        _store.Jobs.Should().BeEmpty();
        _store.StatusMessage.Should().Be("No cron jobs yet.");
    }

    [Fact]
    public void Store_SetError_ExposesErrorText()
    {
        _store.SetError("RPC timeout");

        _store.LastError.Should().Be("RPC timeout");
    }

    [Fact]
    public void Store_SetError_ThenApplySnapshot_ClearsError()
    {
        _store.SetError("old error");

        _store.ApplyJobsSnapshot([], null);

        _store.LastError.Should().BeNull();
    }

    [Fact]
    public void Store_HandleCronEvent_SetsRefreshPending()
    {
        // No pending before the event
        _store.ConsumeRefreshSignal().Should().BeFalse();

        _store.HandleCronEvent("job-1", "started");

        // After gateway push event, polling service should see the signal
        _store.ConsumeRefreshSignal().Should().BeTrue();
        // Consuming clears the flag
        _store.ConsumeRefreshSignal().Should().BeFalse();
    }

    [Fact]
    public void Store_HandleCronEvent_Finished_WithSelectedJob_SetsRunsPending()
    {
        _store.SelectedJobId = "job-abc";

        _store.HandleCronEvent("job-abc", "finished");

        var (pending, jobId) = _store.ConsumeRunsRefreshSignal();
        pending.Should().BeTrue();
        jobId.Should().Be("job-abc");
    }

    [Fact]
    public void Store_SignalRefresh_SetsRefreshPending()
    {
        _store.SignalRefresh();

        _store.ConsumeRefreshSignal().Should().BeTrue();
    }

    [Fact]
    public void Store_StateChanged_FiredOnSnapshot()
    {
        var fired = false;
        _store.StateChanged += (_, _) => fired = true;

        _store.ApplyJobsSnapshot([], null);

        fired.Should().BeTrue();
    }

    // ── RefreshCronJobsOnConnectHandler ───────────────────────────────────────

    [Fact]
    public async Task OnGatewayConnected_SignalsStoreRefresh()
    {
        var handler = new RefreshCronJobsOnConnectHandler(_store);

        await handler.Handle(
            new GatewayConnected { SessionKey = "global" }, CancellationToken.None);

        _store.ConsumeRefreshSignal().Should().BeTrue();
    }

    // ── RunCronJobHandler ─────────────────────────────────────────────────────

    [Fact]
    public async Task RunCronJob_Success_CallsRpcAndReturnsSuccess()
    {
        _rpc.CronRunAsync(Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var handler = new RunCronJobHandler(_rpc);
        var result = await handler.Handle(new RunCronJobCommand("job-1"), default);

        result.IsError.Should().BeFalse();
        await _rpc.Received(1).CronRunAsync("job-1", true, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RunCronJob_RpcThrows_ReturnsFailureError()
    {
        _rpc.CronRunAsync(Arg.Any<string>(), Arg.Any<bool>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromException(new Exception("gateway timeout")));

        var handler = new RunCronJobHandler(_rpc);
        var result = await handler.Handle(new RunCronJobCommand("job-1"), default);

        result.IsError.Should().BeTrue();
        result.FirstError.Code.Should().Be("cron.run.failed");
    }

    // ── UpsertCronJobHandler ──────────────────────────────────────────────────

    [Fact]
    public async Task UpsertCronJob_NullId_CallsCronAddAsync()
    {
        _rpc.CronAddAsync(Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var handler = new UpsertCronJobHandler(_rpc);
        var payload = new Dictionary<string, object?> { ["name"] = "new-job" };
        var result = await handler.Handle(new UpsertCronJobCommand(null, payload), default);

        result.IsError.Should().BeFalse();
        await _rpc.Received(1).CronAddAsync(payload, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task UpsertCronJob_WithId_CallsCronUpdateAsync()
    {
        _rpc.CronUpdateAsync(Arg.Any<string>(), Arg.Any<Dictionary<string, object?>>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var handler = new UpsertCronJobHandler(_rpc);
        var payload = new Dictionary<string, object?> { ["schedule"] = "0 3 * * *" };
        var result = await handler.Handle(new UpsertCronJobCommand("job-1", payload), default);

        result.IsError.Should().BeFalse();
        await _rpc.Received(1).CronUpdateAsync("job-1", payload, Arg.Any<CancellationToken>());
    }
}
