using Serilog;
using Serilog.Events;
using OpenClawWindows.Application.Ports;

namespace OpenClawWindows.Infrastructure.Logging;

// Structured audit log using a dedicated Serilog ILogger (rolling daily files).
// Feeds AgentEventsWindow
// Log directory: %APPDATA%\OpenClaw\logs\, rolling daily, 7-day retention.
internal sealed class SerilogAuditLoggerAdapter : IAuditLogger
{
    private readonly Serilog.ILogger _log;

    // In-memory ring buffer for recent events (feeds AgentEventsWindow)
    private readonly Queue<AuditEntry> _recent = new();

    // Tunables
    private const int MaxRecentEntries = 200; // sliding window — WorkActivityTracker equivalent

    public SerilogAuditLoggerAdapter()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var logDir = Path.Combine(appData, "OpenClaw", "logs");
        Directory.CreateDirectory(logDir);

        _log = new LoggerConfiguration()
            .WriteTo.File(
                path: Path.Combine(logDir, "audit-.jsonl"),
                rollingInterval: RollingInterval.Day,
                retainedFileCountLimit: 7,
                outputTemplate: "{Timestamp:O} [{Level:u3}] {Message:lj}{NewLine}{Exception}",
                formatProvider: null)
            .MinimumLevel.Information()
            .CreateLogger();
    }

    public Task LogAsync(
        string eventType, string commandOrAction, bool succeeded, string? detail,
        CancellationToken ct)
    {
        var entry = new AuditEntry(DateTimeOffset.Now, eventType, commandOrAction, succeeded, detail);

        _log.Write(
            succeeded ? LogEventLevel.Information : LogEventLevel.Warning,
            "audit {EventType} {Action} succeeded={Ok} detail={Detail}",
            eventType, commandOrAction, succeeded, detail);

        lock (_recent)
        {
            _recent.Enqueue(entry);
            while (_recent.Count > MaxRecentEntries)
                _recent.Dequeue();
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<AuditEntry>> GetRecentAsync(int count, CancellationToken ct)
    {
        lock (_recent)
        {
            var list = _recent
                .TakeLast(Math.Min(count, MaxRecentEntries))
                .ToList();
            return Task.FromResult<IReadOnlyList<AuditEntry>>(list);
        }
    }
}
