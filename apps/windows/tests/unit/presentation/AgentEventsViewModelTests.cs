using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.AgentEvents;
using OpenClawWindows.Infrastructure.Stores;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class AgentEventsViewModelTests
{
    private static AgentEventsViewModel MakeVm(out InMemoryAgentEventStore store)
    {
        store = new InMemoryAgentEventStore();
        return new AgentEventsViewModel(store);
    }

    private static AgentEvent MakeEvent(string runId, string stream, double tsMs = 0, string data = "{}") =>
        new(runId, 1, stream, tsMs, data, null);

    [Fact]
    public void Append_AddsEventAtFront()
    {
        var vm = MakeVm(out var store);
        store.Append(MakeEvent("run1", "tool", 1_700_000_000_000));

        Assert.Single(vm.Events);
        Assert.Equal("run run1", vm.Events[0].RunIdDisplay);
    }

    [Fact]
    public void Append_NewestFirst()
    {
        var vm = MakeVm(out var store);
        store.Append(MakeEvent("run1", "tool", 1_700_000_000_000));
        store.Append(MakeEvent("run2", "job",  1_700_000_001_000));

        // Newest inserted at index 0
        Assert.Equal("run run2", vm.Events[0].RunIdDisplay);
        Assert.Equal("run run1", vm.Events[1].RunIdDisplay);
    }

    [Fact]
    public void Clear_RemovesAllEvents()
    {
        var vm = MakeVm(out var store);
        store.Append(MakeEvent("run1", "tool", 1_700_000_000_000));
        vm.ClearCommand.Execute(null);

        Assert.Empty(vm.Events);
    }

    [Fact]
    public void EventRow_StreamUpperCase()
    {
        var vm = MakeVm(out var store);
        store.Append(MakeEvent("r", "assistant"));

        Assert.Equal("ASSISTANT", vm.Events[0].StreamUpperCase);
    }

    [Fact]
    public void EventRow_PrettyJson_Formatted()
    {
        var vm = MakeVm(out var store);
        store.Append(MakeEvent("r", "tool", 0, "{\"key\":\"value\"}"));

        Assert.Contains("\n", vm.Events[0].PrettyJson);
    }

    [Fact]
    public void Backfill_LoadsExistingEventsOnConstruction()
    {
        var store = new InMemoryAgentEventStore();
        store.Append(MakeEvent("pre1", "job"));
        store.Append(MakeEvent("pre2", "tool"));

        var vm = new AgentEventsViewModel(store);

        // Two pre-existing events shown newest-first
        Assert.Equal(2, vm.Events.Count);
        Assert.Equal("run pre2", vm.Events[0].RunIdDisplay);
    }
}
