using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Sessions;

namespace OpenClawWindows.Application.Sessions;

public sealed record ListSessionsQuery(
    int? ActiveMinutes = null,
    int? Limit = null,
    bool IncludeGlobal = true,
    bool IncludeUnknown = true) : IRequest<ErrorOr<SessionsSnapshot>>;

[UseCase("UC-014-sessions-list")]
internal sealed class ListSessionsHandler : IRequestHandler<ListSessionsQuery, ErrorOr<SessionsSnapshot>>
{
    // Tunables
    private const int TimeoutMs           = 15_000;
    private const string FallbackModel    = "claude-opus-4-6";
    private const int FallbackContextSize = 200_000;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IGatewayRpcChannel _rpc;

    public ListSessionsHandler(IGatewayRpcChannel rpc)
    {
        _rpc = rpc;
    }

    public async Task<ErrorOr<SessionsSnapshot>> Handle(ListSessionsQuery query, CancellationToken ct)
    {
        var parameters = new Dictionary<string, object?>
        {
            ["includeGlobal"]  = (object?)query.IncludeGlobal,
            ["includeUnknown"] = (object?)query.IncludeUnknown,
        };
        if (query.ActiveMinutes.HasValue) parameters["activeMinutes"] = (object?)query.ActiveMinutes.Value;
        if (query.Limit.HasValue)         parameters["limit"]         = (object?)query.Limit.Value;

        byte[] data;
        try
        {
            data = await _rpc.RequestRawAsync("sessions.list", parameters, TimeoutMs, ct);
        }
        catch (Exception ex)
        {
            return Error.Failure("SESSIONS_GATEWAY_ERROR", ex.Message);
        }

        GatewaySessionsListResponse decoded;
        try
        {
            decoded = JsonSerializer.Deserialize<GatewaySessionsListResponse>(data, JsonOptions)
                ?? throw new InvalidOperationException("Null sessions.list response");
        }
        catch (Exception ex)
        {
            return Error.Failure("SESSIONS_DECODE_ERROR", ex.Message);
        }

        var defaults = new SessionDefaults(
            decoded.Defaults?.Model ?? FallbackModel,
            decoded.Defaults?.ContextTokens ?? FallbackContextSize);

        var rows = (decoded.Sessions ?? [])
            .Select(e =>
            {
                // Gateway sends updatedAt as Unix-ms double (matches macOS Date(timeIntervalSince1970: x/1000))
                DateTimeOffset? updated = e.UpdatedAt.HasValue
                    ? DateTimeOffset.FromUnixTimeMilliseconds((long)e.UpdatedAt.Value)
                    : null;

                var input  = e.InputTokens  ?? 0;
                var output = e.OutputTokens ?? 0;
                var total  = e.TotalTokens  ?? input + output;

                return new SessionRow
                {
                    Key            = e.Key,
                    DisplayName    = e.DisplayName,
                    Provider       = e.Provider,
                    Subject        = e.Subject,
                    Room           = e.Room,
                    Space          = e.Space,
                    UpdatedAt      = updated,
                    SessionId      = e.SessionId,
                    ThinkingLevel  = e.ThinkingLevel,
                    VerboseLevel   = e.VerboseLevel,
                    SystemSent     = e.SystemSent     ?? false,
                    AbortedLastRun = e.AbortedLastRun ?? false,
                    InputTokens    = input,
                    OutputTokens   = output,
                    TotalTokens    = total,
                    ContextTokens  = e.ContextTokens  ?? defaults.ContextTokens,
                    Model          = e.Model          ?? defaults.Model,
                };
            })
            .OrderByDescending(r => r.UpdatedAt ?? DateTimeOffset.MinValue)
            .ToList();

        return new SessionsSnapshot(decoded.Path, defaults, rows);
    }

    // ── Gateway DTOs (internal — not exposed outside the handler) ──────────────

    private sealed record GatewaySessionDefaultsRecord(string? Model, int? ContextTokens);

    private sealed record GatewaySessionEntryRecord(
        string Key,
        string? DisplayName,
        string? Provider,
        string? Subject,
        string? Room,
        string? Space,
        double? UpdatedAt,
        string? SessionId,
        bool? SystemSent,
        bool? AbortedLastRun,
        string? ThinkingLevel,
        string? VerboseLevel,
        int? InputTokens,
        int? OutputTokens,
        int? TotalTokens,
        string? Model,
        int? ContextTokens);

    private sealed record GatewaySessionsListResponse(
        double? Ts,
        string Path,
        int Count,
        GatewaySessionDefaultsRecord? Defaults,
        IReadOnlyList<GatewaySessionEntryRecord>? Sessions);
}
