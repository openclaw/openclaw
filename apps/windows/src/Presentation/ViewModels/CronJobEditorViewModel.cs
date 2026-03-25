using System.Text.Json;
using System.Text.RegularExpressions;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class CronJobEditorViewModel : ObservableObject
{
    public string IntroText =>
        "Create a schedule that wakes OpenClaw via the Gateway. " +
        "Use an isolated session for agent turns so your main chat stays clean.";

    public string SessionTargetNote =>
        "Main jobs post a system event into the current main session. " +
        "Isolated jobs run OpenClaw in a dedicated session and can announce results to a channel.";

    public string ScheduleKindNote =>
        "\"At\" runs once, \"Every\" repeats with a duration, \"Cron\" uses a 5-field Unix expression.";

    public string IsolatedPayloadNote =>
        "Isolated jobs always run an agent turn. Announce sends a short summary to a channel.";

    public string MainPayloadNote =>
        "System events are injected into the current main session. Agent turns require an isolated session target.";

    private readonly GatewayCronJob? _job;
    private readonly IChannelStore _channelStore;

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private string _description = string.Empty;

    [ObservableProperty]
    private string _agentId = string.Empty;

    [ObservableProperty]
    private bool _enabled = true;

    // "main" | "isolated"
    [ObservableProperty]
    private string _sessionTarget = "main";

    // "now" | "next-heartbeat"
    [ObservableProperty]
    private string _wakeMode = "now";

    [ObservableProperty]
    private bool _deleteAfterRun;

    // "at" | "every" | "cron"
    [ObservableProperty]
    private string _scheduleKind = "every";

    [ObservableProperty]
    private DateTimeOffset _atDate = DateTimeOffset.Now.AddMinutes(5);

    [ObservableProperty]
    private string _everyText = "1h";

    [ObservableProperty]
    private string _cronExpr = "0 9 * * 3";

    [ObservableProperty]
    private string _cronTz = string.Empty;

    // "systemEvent" | "agentTurn"
    [ObservableProperty]
    private string _payloadKind = "systemEvent";

    [ObservableProperty]
    private string _systemEventText = string.Empty;

    [ObservableProperty]
    private string _agentMessage = string.Empty;

    [ObservableProperty]
    private string _thinking = string.Empty;

    [ObservableProperty]
    private string _timeoutSeconds = string.Empty;

    // "announce" | "none"
    [ObservableProperty]
    private string _deliveryMode = "announce";

    [ObservableProperty]
    private string _channel = "last";

    [ObservableProperty]
    private string _to = string.Empty;

    [ObservableProperty]
    private bool _bestEffortDeliver;

    [ObservableProperty]
    private string? _error;

    public string Title => _job is null ? "New cron job" : "Edit cron job";

    // ── Index helpers for ComboBox (WinUI 3 lacks SelectedValuePath for complex objects) ──

    public int SessionTargetIndex
    {
        get => SessionTarget == "isolated" ? 1 : 0;
        set => SessionTarget = value == 1 ? "isolated" : "main";
    }

    public int WakeModeIndex
    {
        get => WakeMode == "next-heartbeat" ? 1 : 0;
        set => WakeMode = value == 1 ? "next-heartbeat" : "now";
    }

    public int ScheduleKindIndex
    {
        get => ScheduleKind switch { "at" => 0, "every" => 1, "cron" => 2, _ => 1 };
        set => ScheduleKind = value switch { 0 => "at", 2 => "cron", _ => "every" };
    }

    public int PayloadKindIndex
    {
        get => PayloadKind == "agentTurn" ? 1 : 0;
        set => PayloadKind = value == 1 ? "agentTurn" : "systemEvent";
    }

    public int DeliveryModeIndex
    {
        get => DeliveryMode == "none" ? 1 : 0;
        set => DeliveryMode = value == 1 ? "none" : "announce";
    }

    // WinUI 3 DatePicker binds to DateTimeOffset; expose date-only portion.
    public DateTimeOffset AtDateOnly
    {
        get => new DateTimeOffset(AtDate.Date, AtDate.Offset);
        set => AtDate = new DateTimeOffset(value.Date + AtDate.TimeOfDay, AtDate.Offset);
    }

    public Visibility ErrorVisibility =>
        string.IsNullOrEmpty(Error) ? Visibility.Collapsed : Visibility.Visible;

    // ── Derived Visibility ──

    public Visibility AtSectionVisibility =>
        ScheduleKind == "at" ? Visibility.Visible : Visibility.Collapsed;

    public Visibility EverySectionVisibility =>
        ScheduleKind == "every" ? Visibility.Visible : Visibility.Collapsed;

    public Visibility CronSectionVisibility =>
        ScheduleKind == "cron" ? Visibility.Visible : Visibility.Collapsed;

    public Visibility IsolatedPayloadVisibility =>
        SessionTarget == "isolated" ? Visibility.Visible : Visibility.Collapsed;

    public Visibility MainPayloadKindVisibility =>
        SessionTarget == "main" ? Visibility.Visible : Visibility.Collapsed;

    public Visibility SystemEventEditorVisibility =>
        SessionTarget == "main" && PayloadKind == "systemEvent"
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility AgentTurnEditorVisibility =>
        SessionTarget == "isolated" || (SessionTarget == "main" && PayloadKind == "agentTurn")
            ? Visibility.Visible : Visibility.Collapsed;

    public Visibility DeliveryRowVisibility =>
        SessionTarget == "isolated" ? Visibility.Visible : Visibility.Collapsed;

    public Visibility DeliveryAnnounceVisibility =>
        SessionTarget == "isolated" && DeliveryMode == "announce"
            ? Visibility.Visible : Visibility.Collapsed;

    // ── Channel options for delivery picker ───────────────────────────────────

    public List<ChannelOption> ChannelOptions
    {
        get
        {
            var ordered = new List<string>();
            var labels  = new Dictionary<string, string>();

            var snapshot = _channelStore.StatusSnapshot;
            if (snapshot.HasValue &&
                snapshot.Value.TryGetProperty("channelOrder", out var orderEl))
            {
                foreach (var idEl in orderEl.EnumerateArray())
                {
                    var id = idEl.GetString() ?? string.Empty;
                    if (!string.IsNullOrEmpty(id)) ordered.Add(id);
                }

                if (snapshot.Value.TryGetProperty("channelLabels", out var labelsEl))
                {
                    foreach (var kv in labelsEl.EnumerateObject())
                        labels[kv.Name] = kv.Value.GetString() ?? kv.Name;
                }
            }

            var options = new List<ChannelOption> { new("last", "last") };
            foreach (var id in ordered)
                options.Add(new(id, labels.TryGetValue(id, out var lbl) ? lbl : id));

            // Include current channel even if not in ordered list
            var trimmed = Channel.Trim();
            if (!string.IsNullOrEmpty(trimmed) && options.All(o => o.Id != trimmed))
                options.Add(new(trimmed, trimmed));

            return options;
        }
    }

    public CronJobEditorViewModel(GatewayCronJob? job, IChannelStore channelStore)
    {
        _job          = job;
        _channelStore = channelStore;
        HydrateFromJob();
    }

    // ── Partial hooks ──────────────────────────────────────────────────────────

    partial void OnScheduleKindChanged(string value)
    {
        OnPropertyChanged(nameof(ScheduleKindIndex));
        OnPropertyChanged(nameof(AtSectionVisibility));
        OnPropertyChanged(nameof(EverySectionVisibility));
        OnPropertyChanged(nameof(CronSectionVisibility));
    }

    partial void OnSessionTargetChanged(string value)
    {
        if (value == "isolated")
            PayloadKind = "agentTurn";
        else if (value == "main" && PayloadKind == "agentTurn")
            PayloadKind = "systemEvent";

        OnPropertyChanged(nameof(SessionTargetIndex));
        OnPropertyChanged(nameof(IsolatedPayloadVisibility));
        OnPropertyChanged(nameof(MainPayloadKindVisibility));
        OnPropertyChanged(nameof(SystemEventEditorVisibility));
        OnPropertyChanged(nameof(AgentTurnEditorVisibility));
        OnPropertyChanged(nameof(DeliveryRowVisibility));
        OnPropertyChanged(nameof(DeliveryAnnounceVisibility));
    }

    partial void OnPayloadKindChanged(string value)
    {
        if (value == "agentTurn" && SessionTarget == "main")
            SessionTarget = "isolated";

        OnPropertyChanged(nameof(PayloadKindIndex));
        OnPropertyChanged(nameof(SystemEventEditorVisibility));
        OnPropertyChanged(nameof(AgentTurnEditorVisibility));
    }

    partial void OnDeliveryModeChanged(string value)
    {
        OnPropertyChanged(nameof(DeliveryModeIndex));
        OnPropertyChanged(nameof(DeliveryAnnounceVisibility));
    }

    partial void OnErrorChanged(string? value)
    {
        OnPropertyChanged(nameof(ErrorVisibility));
    }

    partial void OnWakeModeChanged(string value)
    {
        OnPropertyChanged(nameof(WakeModeIndex));
    }

    partial void OnAtDateChanged(DateTimeOffset value)
    {
        // Keep DatePicker binding in sync when AtDate is set programmatically (e.g. HydrateFromJob).
        OnPropertyChanged(nameof(AtDateOnly));
    }

    // ── Hydration

    private void HydrateFromJob()
    {
        if (_job is null) return;

        Name          = _job.Name;
        Description   = _job.Description ?? string.Empty;
        AgentId       = _job.AgentId ?? string.Empty;
        Enabled       = _job.Enabled;
        DeleteAfterRun = _job.DeleteAfterRun ?? false;
        SessionTarget = GetString(_job.SessionTarget, "main");
        WakeMode      = GetString(_job.WakeMode, "now");

        // Schedule
        if (_job.Schedule.ValueKind == JsonValueKind.Object)
        {
            var kind = GetProp(_job.Schedule, "kind", "every");
            ScheduleKind = kind;

            switch (kind)
            {
                case "at":
                    if (_job.Schedule.TryGetProperty("at", out var atEl))
                    {
                        var iso = atEl.GetString() ?? string.Empty;
                        if (DateTimeOffset.TryParse(iso, System.Globalization.CultureInfo.InvariantCulture, out var dt)) AtDate = dt;
                    }
                    break;

                case "every":
                    if (_job.Schedule.TryGetProperty("everyMs", out var msEl) &&
                        msEl.TryGetInt64(out var ms))
                        EveryText = FormatDuration((int)ms);
                    break;

                case "cron":
                    CronExpr = GetProp(_job.Schedule, "expr", "0 9 * * 3");
                    CronTz   = GetProp(_job.Schedule, "tz", string.Empty);
                    break;
            }
        }

        // Payload
        if (_job.Payload.ValueKind == JsonValueKind.Object)
        {
            var payKind = GetProp(_job.Payload, "kind", "systemEvent");
            PayloadKind = payKind;

            switch (payKind)
            {
                case "systemEvent":
                    SystemEventText = GetProp(_job.Payload, "text", string.Empty);
                    break;

                case "agentTurn":
                    AgentMessage = GetProp(_job.Payload, "message", string.Empty);
                    Thinking     = GetProp(_job.Payload, "thinking", string.Empty);
                    if (_job.Payload.TryGetProperty("timeoutSeconds", out var tsEl) &&
                        tsEl.TryGetInt32(out var ts))
                        TimeoutSeconds = ts.ToString();
                    break;
            }
        }

        // Delivery
        if (_job.Delivery.HasValue && _job.Delivery.Value.ValueKind == JsonValueKind.Object)
        {
            var delMode = GetProp(_job.Delivery.Value, "mode", "none");
            DeliveryMode = delMode == "announce" ? "announce" : "none";
            var ch = GetProp(_job.Delivery.Value, "channel", string.Empty).Trim();
            Channel = string.IsNullOrEmpty(ch) ? "last" : ch;
            To      = GetProp(_job.Delivery.Value, "to", string.Empty);
            if (_job.Delivery.Value.TryGetProperty("bestEffort", out var beEl))
                BestEffortDeliver = beEl.GetBoolean();
        }
        else if (SessionTarget == "isolated")
        {
            DeliveryMode = "announce";
        }
    }

    // ── Build payload

    public Dictionary<string, object?> BuildPayload()
    {
        var name = Name.Trim();
        if (string.IsNullOrEmpty(name))
            throw new InvalidOperationException("Name is required.");

        var schedule = BuildSchedule();
        var payload  = BuildSelectedPayload();

        ValidateSessionTarget(payload);
        ValidatePayloadRequiredFields(payload);

        var root = new Dictionary<string, object?>
        {
            ["name"]          = name,
            ["enabled"]       = Enabled,
            ["schedule"]      = schedule,
            ["sessionTarget"] = SessionTarget,
            ["wakeMode"]      = WakeMode,
            ["payload"]       = payload,
        };

        ApplyDeleteAfterRun(root);

        var desc = Description.Trim();
        if (!string.IsNullOrEmpty(desc)) root["description"] = desc;

        var agentId = AgentId.Trim();
        if (!string.IsNullOrEmpty(agentId))
            root["agentId"] = agentId;
        else if (_job?.AgentId is not null)
            root["agentId"] = null; // explicit null clears on update

        if (SessionTarget == "isolated")
            root["delivery"] = BuildDelivery();

        return root;
    }

    private Dictionary<string, object?> BuildSchedule()
    {
        return ScheduleKind switch
        {
            "at"    => new Dictionary<string, object?> { ["kind"] = "at", ["at"] = AtDate.ToUniversalTime().ToString("o") },
            "every" => ParseDurationMs(EveryText) is int ms
                ? new Dictionary<string, object?> { ["kind"] = "every", ["everyMs"] = ms }
                : throw new InvalidOperationException("Invalid every duration (use 10m, 1h, 1d)."),
            "cron"  => BuildCronSchedule(),
            _       => throw new InvalidOperationException($"Unknown schedule kind: {ScheduleKind}"),
        };
    }

    private Dictionary<string, object?> BuildCronSchedule()
    {
        var expr = CronExpr.Trim();
        if (string.IsNullOrEmpty(expr))
            throw new InvalidOperationException("Cron expression is required.");

        var sched = new Dictionary<string, object?> { ["kind"] = "cron", ["expr"] = expr };
        var tz = CronTz.Trim();
        if (!string.IsNullOrEmpty(tz)) sched["tz"] = tz;
        return sched;
    }

    private Dictionary<string, object?> BuildSelectedPayload()
    {
        if (SessionTarget == "isolated") return BuildAgentTurnPayload();
        return PayloadKind switch
        {
            "systemEvent" => new Dictionary<string, object?> { ["kind"] = "systemEvent", ["text"] = SystemEventText.Trim() },
            "agentTurn"   => BuildAgentTurnPayload(),
            _             => throw new InvalidOperationException($"Unknown payload kind: {PayloadKind}"),
        };
    }

    private Dictionary<string, object?> BuildAgentTurnPayload()
    {
        var p = new Dictionary<string, object?> { ["kind"] = "agentTurn", ["message"] = AgentMessage.Trim() };
        var thinking = Thinking.Trim();
        if (!string.IsNullOrEmpty(thinking)) p["thinking"] = thinking;
        if (int.TryParse(TimeoutSeconds, out var n) && n > 0) p["timeoutSeconds"] = n;
        return p;
    }

    private Dictionary<string, object?> BuildDelivery()
    {
        var d = new Dictionary<string, object?> { ["mode"] = DeliveryMode == "announce" ? "announce" : "none" };
        if (DeliveryMode == "announce")
        {
            var ch = Channel.Trim();
            d["channel"] = string.IsNullOrEmpty(ch) ? "last" : ch;
            var to = To.Trim();
            if (!string.IsNullOrEmpty(to)) d["to"] = to;
            if (BestEffortDeliver)
                d["bestEffort"] = true;
            else if (_job?.Delivery?.TryGetProperty("bestEffort", out var beEl) == true && beEl.GetBoolean())
                d["bestEffort"] = false;
        }
        return d;
    }

    private void ValidateSessionTarget(Dictionary<string, object?> payload)
    {
        if (SessionTarget == "main" && payload.GetValueOrDefault("kind") as string == "agentTurn")
            throw new InvalidOperationException(
                "Main session jobs require systemEvent payloads (switch Session target to isolated).");

        if (SessionTarget == "isolated" && payload.GetValueOrDefault("kind") as string == "systemEvent")
            throw new InvalidOperationException("Isolated jobs require agentTurn payloads.");
    }

    private void ValidatePayloadRequiredFields(Dictionary<string, object?> payload)
    {
        if (payload.GetValueOrDefault("kind") as string == "systemEvent" &&
            string.IsNullOrWhiteSpace(payload.GetValueOrDefault("text") as string))
            throw new InvalidOperationException("System event text is required.");

        if (payload.GetValueOrDefault("kind") as string == "agentTurn" &&
            string.IsNullOrWhiteSpace(payload.GetValueOrDefault("message") as string))
            throw new InvalidOperationException("Agent message is required.");
    }

    private void ApplyDeleteAfterRun(Dictionary<string, object?> root)
    {
        if (ScheduleKind == "at")
            root["deleteAfterRun"] = DeleteAfterRun;
        else if (_job?.DeleteAfterRun is not null)
            root["deleteAfterRun"] = false; // clear when switching away from "at"
    }

    // ── Duration helpers

    internal static int? ParseDurationMs(string input)
    {
        var raw = input.Trim();
        if (string.IsNullOrEmpty(raw)) return null;

        var m = Regex.Match(raw, @"^(\d+(?:\.\d+)?)(ms|s|m|h|d)$", RegexOptions.IgnoreCase);
        if (!m.Success) return null;

        if (!double.TryParse(m.Groups[1].Value, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var n)
            || !double.IsFinite(n) || n <= 0) return null;

        var factor = m.Groups[2].Value.ToLowerInvariant() switch
        {
            "ms" => 1.0,
            "s"  => 1_000.0,
            "m"  => 60_000.0,
            "h"  => 3_600_000.0,
            _    => 86_400_000.0,
        };

        return (int)Math.Floor(n * factor);
    }

    private static string FormatDuration(int ms)
    {
        if (ms < 1_000)         return $"{ms}ms";
        if (ms < 60_000)        return $"{ms / 1_000}s";
        if (ms < 3_600_000)     return $"{ms / 60_000}m";
        if (ms < 86_400_000)    return $"{ms / 3_600_000}h";
        return $"{ms / 86_400_000}d";
    }

    private static string GetProp(JsonElement el, string prop, string fallback)
        => el.TryGetProperty(prop, out var p) ? (p.GetString() ?? fallback) : fallback;

    private static string GetString(JsonElement el, string fallback)
        => el.ValueKind == JsonValueKind.String ? (el.GetString() ?? fallback) : fallback;

    public sealed record ChannelOption(string Id, string Label);
}
