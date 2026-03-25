using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Infrastructure.ExecApprovals;

// Named-pipe IPC server/client for exec approval protocol.
// Wire: 4-byte LE uint32 length prefix + UTF-8 JSON body (OQ-001).
// Security model:
//   type="request" → token equality check, then prompt handler
//   type="exec"    → TTL 10 s + HMAC-SHA256(key=token, msg="{nonce}:{ts}:{requestJson}")
//   peer identity  → RunAsClient impersonation (Windows equivalent of getpeereid)
internal sealed class NamedPipeExecApprovalAdapter : IExecApprovalIpc
{
    private const string PipeName = "openclaw-approvals";

    // Tunables
    private const int TtlMs             = 10_000;
    private const int MaxFrameBytes     = 4 * 1024 * 1024; // 4 MB sanity guard (OQ-001)
    private const int DefaultExecTimeoutMs = 30_000;

    private static readonly JsonSerializerOptions CamelCase = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static readonly JsonSerializerOptions CaseInsensitive = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly IExecApprovalsRepository _approvals;
    private readonly ILogger<NamedPipeExecApprovalAdapter> _logger;

    public NamedPipeExecApprovalAdapter(
        IExecApprovalsRepository approvals,
        ILogger<NamedPipeExecApprovalAdapter> logger)
    {
        _approvals = approvals;
        _logger = logger;
    }

    public async Task<ErrorOr<Success>> StartServerAsync(CancellationToken ct)
    {
        // Validates that we can create the pipe (permissions check) before entering the accept loop.
        try
        {
            using var probe = new NamedPipeServerStream(
                PipeName, PipeDirection.InOut,
                maxNumberOfServerInstances: NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
            return Result.Success;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Cannot create named pipe '{Name}'", PipeName);
            return Error.Failure("PIPE_UNAVAILABLE", ex.Message);
        }
    }

    public async Task StartListeningAsync(
        Func<NamedPipeFrame, Task<bool>> handler, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var server = new NamedPipeServerStream(
                PipeName, PipeDirection.InOut,
                maxNumberOfServerInstances: NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

            try
            {
                await server.WaitForConnectionAsync(ct);
                // Fire-and-forget so the accept loop immediately returns to wait for the next client.
                _ = HandleConnectionAsync(server, handler, ct);
            }
            catch (OperationCanceledException)
            {
                server.Dispose();
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Named pipe accept loop error");
                server.Dispose();
                await Task.Delay(500, ct);
            }
        }
    }

    public async Task<bool> RequestApprovalAsync(NamedPipeFrame request, CancellationToken ct)
    {
        using var client = new NamedPipeClientStream(
            ".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);

        await client.ConnectAsync(ct);
        await WriteFrameAsync(client, request, ct);
        var response = await ReadFrameAsync(client, ct);

        if (response is null) return false;
        var doc = JsonDocument.Parse(response);
        return doc.RootElement.TryGetProperty("approved", out var approved) && approved.GetBoolean();
    }

    // ── Connection dispatch ────────────────────────────────────────────────────

    private async Task HandleConnectionAsync(
        NamedPipeServerStream server,
        Func<NamedPipeFrame, Task<bool>> handler,
        CancellationToken ct)
    {
        using (server)
        {
            try
            {
                // Windows equivalent of getpeereid(): impersonate the client, read their identity,
                // and confirm it matches the current process owner.
                if (!IsAllowedPeer(server))
                {
                    _logger.LogWarning("Named pipe connection rejected: peer identity mismatch");
                    return;
                }

                var json = await ReadFrameAsync(server, ct);
                if (json is null) return;

                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var typeProp)) return;

                switch (typeProp.GetString())
                {
                    case "request":
                        // macOS protocol: token-verified approval prompt
                        await HandleApprovalRequestAsync(server, root, handler, ct);
                        break;

                    case "exec":
                        // macOS protocol: HMAC-SHA256 + TTL authenticated exec
                        await HandleExecRequestAsync(server, root, ct);
                        break;

                    case "approval_request":
                        // Windows-internal legacy type used by EvaluateExecRequestHandler
                        await HandleLegacyApprovalRequestAsync(server, json, handler, ct);
                        break;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _logger.LogError(ex, "Error handling named pipe connection");
            }
        }
    }

    // ── type="request" — token verification + approval prompt ─────────────────

    private async Task HandleApprovalRequestAsync(
        NamedPipeServerStream server,
        JsonElement root,
        Func<NamedPipeFrame, Task<bool>> handler,
        CancellationToken ct)
    {
        var id = GetStringOrNewId(root, "id");
        var receivedToken = root.TryGetProperty("token", out var tp) ? tp.GetString() : null;

        var resolved = await _approvals.ResolveAsync(null, ct);
        if (receivedToken != resolved.Token)
        {
            // Token mismatch
            await WriteDecisionAsync(server, id, ExecApprovalDecision.Deny, ct);
            return;
        }

        var requestJson = root.TryGetProperty("request", out var rp) ? rp.GetRawText() : "{}";
        var frame = NamedPipeFrame.ApprovalRequest(requestJson, id);
        var approved = await handler(frame);

        var decision = approved ? ExecApprovalDecision.AllowOnce : ExecApprovalDecision.Deny;
        await WriteDecisionAsync(server, id, decision, ct);
    }

    // ── type="exec" — HMAC-SHA256 + TTL 10 s ─────────────────────────────────

    private async Task HandleExecRequestAsync(
        NamedPipeServerStream server,
        JsonElement root,
        CancellationToken ct)
    {
        var id = GetStringOrNewId(root, "id");

        // TTL
        var ts = root.TryGetProperty("ts", out var tsProp) ? tsProp.GetInt64() : 0L;
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (Math.Abs(nowMs - ts) > TtlMs)
        {
            await WriteExecErrorAsync(server, id, "INVALID_REQUEST", "expired request", "ttl", ct);
            return;
        }

        // HMAC
        var nonce       = root.TryGetProperty("nonce",       out var np) ? np.GetString() ?? "" : "";
        var receivedHmac = root.TryGetProperty("hmac",        out var hp) ? hp.GetString() ?? "" : "";
        var requestJson  = root.TryGetProperty("requestJson", out var rp) ? rp.GetString() ?? "" : "";

        var resolved     = await _approvals.ResolveAsync(null, ct);
        var expectedHmac = ComputeHmacHex(resolved.Token, nonce, ts, requestJson);

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expectedHmac),
                Encoding.UTF8.GetBytes(receivedHmac)))
        {
            await WriteExecErrorAsync(server, id, "INVALID_REQUEST", "invalid auth", "hmac", ct);
            return;
        }

        ExecHostRequestDto? request;
        try
        {
            request = JsonSerializer.Deserialize<ExecHostRequestDto>(requestJson, CaseInsensitive);
        }
        catch
        {
            await WriteExecErrorAsync(server, id, "INVALID_REQUEST", "invalid payload", "json", ct);
            return;
        }

        if (request is null || request.Command.Length == 0)
        {
            await WriteExecErrorAsync(server, id, "INVALID_REQUEST", "missing command", "json", ct);
            return;
        }

        var result = await RunCommandAsync(request, ct);
        await WriteExecResponseAsync(server, id, result, ct);
    }

    // ── Legacy Windows-internal "approval_request" type ───────────────────────

    private async Task HandleLegacyApprovalRequestAsync(
        NamedPipeServerStream server,
        string json,
        Func<NamedPipeFrame, Task<bool>> handler,
        CancellationToken ct)
    {
        var dto = JsonSerializer.Deserialize<FrameDto>(json, CaseInsensitive);
        if (dto is null || string.IsNullOrEmpty(dto.CorrelationId)) return;

        var frame = NamedPipeFrame.ApprovalRequest(
            dto.PayloadJson ?? dto.CommandJson ?? "{}",
            dto.CorrelationId);

        var approved = await handler(frame);
        var response = NamedPipeFrame.ApprovalResponse(approved, frame.CorrelationId);
        await WriteFrameAsync(server, response, ct);
    }

    // ── Execution ─────────────────────────────────────────────────────────────

    private static async Task<ExecRunResult> RunCommandAsync(ExecHostRequestDto request, CancellationToken ct)
    {
        var sw      = Stopwatch.StartNew();
        var timedOut = false;
        var exitCode = -1;
        string stdout = "", stderr = "", error = "";

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName               = request.Command[0],
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true,
            };

            if (!string.IsNullOrWhiteSpace(request.Cwd))
                psi.WorkingDirectory = request.Cwd;

            foreach (var arg in request.Command.Skip(1))
                psi.ArgumentList.Add(arg);

            if (request.Env is not null)
                foreach (var kv in request.Env)
                    psi.Environment[kv.Key] = kv.Value;

            using var process = new Process { StartInfo = psi };
            process.Start();

            var stdoutTask = process.StandardOutput.ReadToEndAsync(ct);
            var stderrTask = process.StandardError.ReadToEndAsync(ct);

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(request.TimeoutMs ?? DefaultExecTimeoutMs);

            try
            {
                await process.WaitForExitAsync(cts.Token);
                exitCode = process.ExitCode;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                timedOut = true;
                process.Kill(entireProcessTree: true);
            }

            stdout = await stdoutTask;
            stderr = await stderrTask;
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        sw.Stop();
        var success = !timedOut && exitCode == 0 && string.IsNullOrEmpty(error);
        return new ExecRunResult(exitCode, timedOut, success, stdout, stderr,
            string.IsNullOrEmpty(error) ? null : error);
    }

    // ── Security helpers ──────────────────────────────────────────────────────

    // Windows equivalent of getpeereid(): impersonates the pipe client and compares
    // the resulting Windows identity to the current process owner.
    private static bool IsAllowedPeer(NamedPipeServerStream server)
    {
        try
        {
            var serverUser = WindowsIdentity.GetCurrent().Name;
            string? clientUser = null;
            server.RunAsClient(() => { clientUser = WindowsIdentity.GetCurrent().Name; });
            return string.Equals(serverUser, clientUser, StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    // Message format: "{nonce}:{ts}:{requestJson}" — key is the token as UTF-8 bytes.
    private static string ComputeHmacHex(string token, string nonce, long ts, string requestJson)
    {
        var key     = Encoding.UTF8.GetBytes(token);
        var message = Encoding.UTF8.GetBytes($"{nonce}:{ts}:{requestJson}");
        var mac     = HMACSHA256.HashData(key, message);
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    // ── Wire I/O ──────────────────────────────────────────────────────────────

    private static async Task WriteDecisionAsync(
        PipeStream pipe, string id, ExecApprovalDecision decision, CancellationToken ct)
    {
        var payload = new { type = "decision", id, decision };
        var json    = JsonSerializer.Serialize(payload, CamelCase);
        await WriteLengthPrefixedAsync(pipe, json, ct);
    }

    private static async Task WriteExecErrorAsync(
        PipeStream pipe, string id, string code, string message, string reason, CancellationToken ct)
    {
        var payload = new
        {
            type    = "exec-res",
            id,
            ok      = false,
            payload = (object?)null,
            error   = new { code, message, reason }
        };
        await WriteLengthPrefixedAsync(pipe, JsonSerializer.Serialize(payload, CamelCase), ct);
    }

    private static async Task WriteExecResponseAsync(
        PipeStream pipe, string id, ExecRunResult r, CancellationToken ct)
    {
        var payload = new
        {
            type    = "exec-res",
            id,
            ok      = r.Success,
            payload = new
            {
                exitCode = r.ExitCode,
                timedOut = r.TimedOut,
                success  = r.Success,
                stdout   = r.Stdout,
                stderr   = r.Stderr,
                error    = r.Error,
            },
            error   = (object?)null,
        };
        await WriteLengthPrefixedAsync(pipe, JsonSerializer.Serialize(payload, CamelCase), ct);
    }

    private static async Task WriteFrameAsync(PipeStream pipe, NamedPipeFrame frame, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(frame, CamelCase);
        await WriteLengthPrefixedAsync(pipe, json, ct);
    }

    private static async Task WriteLengthPrefixedAsync(PipeStream pipe, string json, CancellationToken ct)
    {
        var body        = Encoding.UTF8.GetBytes(json);
        var lengthBytes = BitConverter.GetBytes((uint)body.Length);
        if (!BitConverter.IsLittleEndian)
            Array.Reverse(lengthBytes);
        await pipe.WriteAsync(lengthBytes, ct);
        await pipe.WriteAsync(body, ct);
    }

    private static async Task<string?> ReadFrameAsync(PipeStream pipe, CancellationToken ct)
    {
        var lenBuf = new byte[4];
        var read   = await pipe.ReadAsync(lenBuf, ct);
        if (read < 4) return null;

        if (!BitConverter.IsLittleEndian)
            Array.Reverse(lenBuf);

        var length = (int)BitConverter.ToUInt32(lenBuf, 0);
        if (length is 0 or > MaxFrameBytes)
            return null;

        var body       = new byte[length];
        var totalRead  = 0;
        while (totalRead < length)
        {
            var n = await pipe.ReadAsync(body.AsMemory(totalRead, length - totalRead), ct);
            if (n == 0) return null;
            totalRead += n;
        }

        return Encoding.UTF8.GetString(body);
    }

    private static string GetStringOrNewId(JsonElement root, string key)
        => root.TryGetProperty(key, out var p) ? p.GetString() ?? Guid.NewGuid().ToString() : Guid.NewGuid().ToString();

    // ── DTOs ──────────────────────────────────────────────────────────────────

    private sealed class ExecHostRequestDto
    {
        [JsonPropertyName("command")]   public string[]                    Command    { get; set; } = [];
        [JsonPropertyName("rawCommand")] public string?                   RawCommand { get; set; }
        [JsonPropertyName("cwd")]       public string?                    Cwd        { get; set; }
        [JsonPropertyName("env")]       public Dictionary<string, string>? Env       { get; set; }
        [JsonPropertyName("timeoutMs")] public int?                       TimeoutMs  { get; set; }
        [JsonPropertyName("agentId")]   public string?                    AgentId    { get; set; }
        [JsonPropertyName("sessionKey")] public string?                   SessionKey { get; set; }
    }

    private sealed record ExecRunResult(
        int     ExitCode,
        bool    TimedOut,
        bool    Success,
        string  Stdout,
        string  Stderr,
        string? Error);

    // Legacy DTO for Windows-internal "approval_request" type.
    private sealed class FrameDto
    {
        public string? PayloadJson  { get; set; }
        public string? CommandJson  { get; set; }
        public string  CorrelationId { get; set; } = "";
        public string  MessageType  { get; set; }  = "approval_request";
    }
}
