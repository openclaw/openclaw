using System.Collections.ObjectModel;
using System.Text.Json;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.AgentEvents;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class AgentEventsViewModel : ObservableObject
{
    private readonly IAgentEventStore _store;
    private readonly DispatcherQueue? _dispatcher;

    // Newest-first
    public ObservableCollection<AgentEventRow> Events { get; } = [];

    public AgentEventsViewModel(IAgentEventStore store)
    {
        _store = store;
        // GetForCurrentThread() throws COMException (REGDB_E_CLASSNOTREG) when WinRT COM is
        // not initialized (unit-test context without Bootstrap). Treat that as "no dispatcher".
        try { _dispatcher = DispatcherQueue.GetForCurrentThread(); }
        catch { _dispatcher = null; }

        // Backfill events that arrived before this window was opened.
        foreach (var evt in store.Events)
            PrependRow(evt);

        store.EventAppended += OnEventAppended;
    }

    [RelayCommand]
    private void Clear()
    {
        _store.Clear();
        Events.Clear();
    }

    // ── Live event handling ───────────────────────────────────────────────────

    private void OnEventAppended(object? sender, AgentEvent evt)
    {
        // Gateway events arrive on the receive-loop thread; marshal to UI thread if available.
        // No dispatcher means we are in a unit-test context — update synchronously.
        if (_dispatcher is { } dq)
            dq.TryEnqueue(() => PrependRow(evt));
        else
            PrependRow(evt);
    }

    private void PrependRow(AgentEvent evt)
    {
        Events.Insert(0, new AgentEventRow(evt.RunId, evt.Stream, evt.TsMs, evt.DataJson));
    }

    // ── Row model — unchanged from original ──────────────────────────────────

    public sealed class AgentEventRow
    {
        public string Stream             { get; }
        public string StreamUpperCase    { get; }
        public string RunIdDisplay       { get; }
        public string FormattedTimestamp { get; }
        public string PrettyJson         { get; }

        public AgentEventRow(string runId, string stream, double timestampMs, string payloadJson)
        {
            Stream             = stream;
            StreamUpperCase    = stream.ToUpperInvariant();
            RunIdDisplay       = "run " + runId;

            var date = DateTimeOffset.FromUnixTimeMilliseconds((long)timestampMs);
            FormattedTimestamp = date.LocalDateTime.ToString("HH:mm:ss.fff");

            PrettyJson = TryPrettyPrint(payloadJson) ?? payloadJson;
        }

        private static string? TryPrettyPrint(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                return JsonSerializer.Serialize(
                    doc.RootElement,
                    new JsonSerializerOptions { WriteIndented = true });
            }
            catch
            {
                return null;
            }
        }
    }
}
