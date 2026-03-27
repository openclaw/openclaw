using System.Text.Json;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

// Evaluates a system.run request through the full policy engine:
// resolve approvals → env sanitize → command resolution → allowlist match → skill bins → IPC prompt.
[UseCase("UC-018")]
public sealed record EvaluateExecRequestCommand(string CommandJson, string CorrelationId)
    : IRequest<ErrorOr<ShellCommandResult>>;

internal sealed class EvaluateExecRequestHandler
    : IRequestHandler<EvaluateExecRequestCommand, ErrorOr<ShellCommandResult>>
{
    private readonly IExecApprovalIpc _ipc;
    private readonly IShellExecutor _shell;
    private readonly IExecApprovalsRepository _approvals;
    private readonly ISkillBinsCache _skillBins;
    private readonly IAuditLogger _audit;
    private readonly INodeRuntimeContext _nodeRuntime;
    private readonly ILogger<EvaluateExecRequestHandler> _logger;

    public EvaluateExecRequestHandler(
        IExecApprovalIpc ipc,
        IShellExecutor shell,
        IExecApprovalsRepository approvals,
        ISkillBinsCache skillBins,
        IAuditLogger audit,
        INodeRuntimeContext nodeRuntime,
        ILogger<EvaluateExecRequestHandler> logger)
    {
        _ipc = ipc;
        _shell = shell;
        _approvals = approvals;
        _skillBins = skillBins;
        _audit = audit;
        _nodeRuntime = nodeRuntime;
        _logger = logger;
    }

    public async Task<ErrorOr<ShellCommandResult>> Handle(
        EvaluateExecRequestCommand cmd, CancellationToken ct)
    {
        Guard.Against.NullOrWhiteSpace(cmd.CommandJson, nameof(cmd.CommandJson));

        // ── 1. Parse request JSON ─────────────────────────────────────────────
        using var doc = JsonDocument.Parse(cmd.CommandJson);
        var root = doc.RootElement;

        var command = ParseStringArray(root, "command");
        var rawCommand = root.TryGetProperty("rawCommand", out var rc) ? rc.GetString() : null;
        var cwd = root.TryGetProperty("cwd", out var cwdEl) ? cwdEl.GetString() : null;
        // Gateway sends env; envOverrides is a compat alias. Merge with envOverrides winning.
        var envOverrides = MergeEnv(ParseStringDict(root, "env"), ParseStringDict(root, "envOverrides"));
        var agentId = root.TryGetProperty("agentId", out var ai) ? ai.GetString()?.Trim() : null;
        if (string.IsNullOrEmpty(agentId)) agentId = null;
        var sessionKeyRaw = root.TryGetProperty("sessionKey", out var sk) ? sk.GetString()?.Trim() : null;
        var sessionKey = !string.IsNullOrEmpty(sessionKeyRaw)
            ? sessionKeyRaw!
            : _nodeRuntime.MainSessionKey;
        int? timeoutMs = root.TryGetProperty("timeoutMs", out var tm) && tm.ValueKind == JsonValueKind.Number
            ? tm.GetInt32()
            : null;

        // Run ExecSystemRunCommandValidator + trim via ExecHostRequestEvaluator — security gate.
        var validateResult = ExecHostRequestEvaluator.ValidateRequest(new ExecHostRequest
        {
            Command    = command,
            RawCommand = rawCommand,
            Cwd        = cwd,
            AgentId    = agentId,
            SessionKey = sessionKeyRaw,
            TimeoutMs  = timeoutMs,
            Env        = envOverrides,
        });
        if (validateResult is ExecHostValidateResult.Failed vf)
            return Error.Failure("EXEC.INVALID", vf.Error.Message);
        var validated = ((ExecHostValidateResult.Ok)validateResult).Validated;
        command      = validated.Command;
        var displayCommand = validated.DisplayCommand;
        var runId = Guid.NewGuid().ToString();

        // ── 2. Resolve approval policy for this agent ─────────────────────────
        var resolved = await _approvals.ResolveAsync(agentId, ct);
        var security = resolved.Agent.Security;
        var ask = resolved.Agent.Ask;

        // ── 3. Sanitize environment ───────────────────────────────────────────
        var shellWrapper = ExecShellWrapperParser.Extract(command, rawCommand).IsWrapper;
        var env = HostEnvSanitizer.Sanitize(envOverrides, shellWrapper);

        // ── 4. Resolve command for allowlist matching ──────────────────────────
        var allowlistResolutions = ExecCommandResolution.ResolveForAllowlist(
            command, rawCommand, cwd, env);

        // ── 5. Allowlist + skill-bins evaluation ──────────────────────────────
        var allowlistMatches = security == ExecSecurity.Allowlist
            ? ExecAllowlistMatcher.MatchAll(resolved.Allowlist, allowlistResolutions)
            : [];

        var allowlistSatisfied = security == ExecSecurity.Allowlist &&
            allowlistResolutions.Count > 0 &&
            allowlistMatches.Count == allowlistResolutions.Count;

        bool skillAllow = false;
        if (resolved.Agent.AutoAllowSkills && allowlistResolutions.Count > 0)
        {
            var bins = await _skillBins.CurrentBinsAsync(ct);
            skillAllow = allowlistResolutions.All(r =>
                bins.Contains(r.ExecutableName));
        }

        var allowlistMatch = allowlistSatisfied ? allowlistMatches.FirstOrDefault() : null;

        // ── 6. Policy decision via ExecHostRequestEvaluator chain ─────────────
        var evalContext = new ExecApprovalEvaluation
        {
            Command              = command,
            DisplayCommand       = displayCommand,
            AgentId              = agentId,
            Security             = security,
            Ask                  = ask,
            Env                  = env ?? new Dictionary<string, string>(),
            Resolution           = allowlistResolutions.Count > 0 ? allowlistResolutions[0] : null,
            AllowlistResolutions = allowlistResolutions,
            AllowlistMatches     = allowlistMatches,
            AllowlistSatisfied   = allowlistSatisfied,
            AllowlistMatch       = allowlistMatch,
            SkillAllow           = skillAllow,
        };

        var decision = ExecHostRequestEvaluator.Evaluate(evalContext, null);

        if (decision is ExecHostPolicyDecision.RequiresPrompt)
        {
            // NamedPipeFrame.ApprovalRequest expects valid JSON — serialize the prompt payload.
            var approvalPayloadJson = System.Text.Json.JsonSerializer.Serialize(
                new { command = displayCommand, cwd });
            var frame = NamedPipeFrame.ApprovalRequest(approvalPayloadJson, cmd.CorrelationId);
            var approved = await _ipc.RequestApprovalAsync(frame, ct);
            var approvalDecision = approved ? ExecApprovalDecision.AllowOnce : ExecApprovalDecision.Deny;
            // Second evaluation with user's decision
            decision = ExecHostRequestEvaluator.Evaluate(evalContext, approvalDecision);
        }

        if (decision is ExecHostPolicyDecision.Deny deny)
        {
            _logger.LogInformation("ExecApproval denied ({Reason}) correlationId={Id}",
                deny.Error.Reason, cmd.CorrelationId);
            _nodeRuntime.EmitExecEvent("exec.denied", new ExecEventPayload
            {
                SessionKey = sessionKey, RunId = runId, Host = "node",
                Command = displayCommand, Reason = deny.Error.Reason,
            });
            return Error.Failure("EXEC.DENIED", deny.Error.Message);
        }

        // ── 7. Execute ────────────────────────────────────────────────────────
        var session = ExecApprovalSession.Create(
            await _approvals.LoadAsync(ct));
        session.RequestApproval(cmd.CommandJson, cmd.CorrelationId);
        session.Approve();
        session.BeginExecution();

        // Use the resolved path when available so we execute the canonical binary.
        var executable = allowlistResolutions.Count > 0 && allowlistResolutions[0].ResolvedPath is not null
            ? allowlistResolutions[0].ResolvedPath!
            : command[0];
        var args = command.Skip(1).ToArray();

        _nodeRuntime.EmitExecEvent("exec.started", new ExecEventPayload
        {
            SessionKey = sessionKey, RunId = runId, Host = "node",
            Command = displayCommand,
        });

        var result = await _shell.RunAsync(executable, args, timeoutMs, ct, cwd, env);

        bool timedOut = result.IsError && result.FirstError.Code == "EXEC_TIMEOUT";
        bool success  = !result.IsError && result.Value.IsSuccess;

        var combined = result.IsError
            ? result.FirstError.Description
            : string.Join("\n", new[] { result.Value.Stdout, result.Value.Stderr }
                .Where(s => !string.IsNullOrEmpty(s)));

        _nodeRuntime.EmitExecEvent("exec.finished", new ExecEventPayload
        {
            SessionKey = sessionKey,
            RunId      = runId,
            Host       = "node",
            Command    = displayCommand,
            ExitCode   = result.IsError ? null : result.Value.ExitCode,
            TimedOut   = timedOut,
            Success    = success,
            Output     = ExecEventPayload.TruncateOutput(combined),
        });

        if (result.IsError)
            session.MarkFailed();
        else
            session.MarkCompleted();

        await _audit.LogAsync("system.run", executable, !result.IsError,
            result.IsError ? result.FirstError.Description : null, ct);

        return result;
    }

    // ── JSON helpers ──────────────────────────────────────────────────────────

    private static IReadOnlyList<string> ParseStringArray(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var el) || el.ValueKind != JsonValueKind.Array)
            return [];
        return el.EnumerateArray()
            .Select(e => e.GetString() ?? string.Empty)
            .ToList();
    }

    private static IReadOnlyDictionary<string, string>? ParseStringDict(JsonElement root, string key)
    {
        if (!root.TryGetProperty(key, out var el) || el.ValueKind != JsonValueKind.Object)
            return null;
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var prop in el.EnumerateObject())
            dict[prop.Name] = prop.Value.GetString() ?? string.Empty;
        return dict;
    }

    private static IReadOnlyDictionary<string, string>? MergeEnv(
        IReadOnlyDictionary<string, string>? primary,
        IReadOnlyDictionary<string, string>? overrides)
    {
        if (primary is null)  return overrides;
        if (overrides is null) return primary;
        var merged = new Dictionary<string, string>(primary, StringComparer.OrdinalIgnoreCase);
        foreach (var (k, v) in overrides) merged[k] = v;
        return merged;
    }
}
