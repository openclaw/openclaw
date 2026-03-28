using System.Text.Json;
using System.Text.Json.Serialization;
using OpenClawWindows.Application.Behaviors;
using OpenClawWindows.Application.Camera;
using OpenClawWindows.Application.Canvas;
using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Notifications;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.NodeMode;

// Routes node.invoke messages from the gateway to the correct command handler.
public sealed record NodeInvokeRequest(string Id, string Command, string ParamsJson);
public sealed record NodeInvokeResponse(string Id, bool Ok, string? PayloadJson, string? Error);

public sealed record DispatchNodeInvokeCommand(NodeInvokeRequest Request)
    : IRequest<NodeInvokeResponse>;

[UseCase("UC-001-DISPATCH")]
internal sealed class NodeInvokeDispatcher : IRequestHandler<DispatchNodeInvokeCommand, NodeInvokeResponse>
{
    private readonly IMediator _mediator;
    private readonly ILogger<NodeInvokeDispatcher> _logger;

    public NodeInvokeDispatcher(IMediator mediator, ILogger<NodeInvokeDispatcher> logger)
    {
        _mediator = mediator;
        _logger = logger;
    }

    public async Task<NodeInvokeResponse> Handle(DispatchNodeInvokeCommand cmd, CancellationToken ct)
    {
        var req = cmd.Request;
        _logger.LogInformation("node.invoke id={Id} command={Command}", req.Id, req.Command);

        try
        {
            var payloadJson = await DispatchAsync(req, ct);
            return new NodeInvokeResponse(req.Id, true, payloadJson, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "node.invoke failed id={Id} command={Command}", req.Id, req.Command);
            return new NodeInvokeResponse(req.Id, false, null, ex.ToString());
        }
    }

    private async Task<string?> DispatchAsync(NodeInvokeRequest req, CancellationToken ct)
    {
        return req.Command switch
        {
            "camera.list" => await HandleCameraListAsync(ct),
            "camera.snap" => await HandleCameraSnapAsync(req.ParamsJson, ct),
            "camera.clip" => await HandleCameraClipAsync(req.ParamsJson, ct),
            "screen.record" => await HandleScreenRecordAsync(req.ParamsJson, ct),
            "system.run" => await HandleSystemRunAsync(req.ParamsJson, req.Id, ct),
            "system.which" => await HandleSystemWhichAsync(req.ParamsJson, ct),
            "system.notify" => await HandleSystemNotifyAsync(req.ParamsJson, ct),
            "system.execApprovals.get" => await HandleGetExecApprovalsAsync(ct),
            "system.execApprovals.set" => await HandleSetExecApprovalsAsync(req.ParamsJson, ct),
            "location.get" => await HandleLocationGetAsync(req.ParamsJson, ct),
            "canvas.present" => await HandleCanvasPresentAsync(req.ParamsJson, ct),
            "canvas.hide" => await HandleCanvasHideAsync(ct),
            "canvas.navigate" => await HandleCanvasNavigateAsync(req.ParamsJson, ct),
            "canvas.eval" or "canvas.evalJS" => await HandleCanvasEvalAsync(req.ParamsJson, ct),
            "canvas.snapshot" => await HandleCanvasSnapshotAsync(ct),
            "browser.proxy" => await HandleBrowserProxyAsync(req.ParamsJson, ct),
            // canvas.a2ui.* (macOS protocol name) and a2ui.* (legacy Windows name)
            var cmd when cmd.StartsWith("canvas.a2ui.") || cmd.StartsWith("a2ui.") => await HandleA2UIAsync(req.Command, req.ParamsJson, ct),
            _ => throw new NotSupportedException($"Unknown command: {req.Command}")
        };
    }

    private async Task<string> HandleCameraListAsync(CancellationToken ct)
    {
        var result = await _mediator.Send(new CameraListQuery(), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return JsonSerializer.Serialize(new { devices = result.Value });
    }

    private async Task<string> HandleCameraSnapAsync(string paramsJson, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(paramsJson);
        var deviceId = doc.RootElement.TryGetProperty("deviceId", out var d) ? d.GetString() ?? "" : "";
        int? delayMs = doc.RootElement.TryGetProperty("delayMs", out var dl) && dl.ValueKind == JsonValueKind.Number ? dl.GetInt32() : null;

        var result = await _mediator.Send(new CameraSnapCommand(deviceId, delayMs), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var snap = result.Value;
        return JsonSerializer.Serialize(new { format = snap.Format, base64 = snap.Base64, width = snap.Width, height = snap.Height });
    }

    private async Task<string> HandleCameraClipAsync(string paramsJson, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(paramsJson);
        var deviceId = doc.RootElement.TryGetProperty("deviceId", out var d) ? d.GetString() ?? "" : "";
        var durationMs = doc.RootElement.TryGetProperty("durationMs", out var du) && du.ValueKind == JsonValueKind.Number ? du.GetInt32() : 3000;
        var includeAudio = doc.RootElement.TryGetProperty("includeAudio", out var ia) && ia.ValueKind == JsonValueKind.True;

        var result = await _mediator.Send(new CameraClipCommand(deviceId, durationMs, includeAudio), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var clip = result.Value;
        return JsonSerializer.Serialize(new { format = clip.Format, base64 = clip.Base64, durationMs = clip.DurationMs, hasAudio = clip.HasAudio });
    }

    private async Task<string> HandleScreenRecordAsync(string paramsJson, CancellationToken ct)
    {
        var result = await _mediator.Send(new NodeScreenRecordCommand(paramsJson), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var rec = result.Value;
        // Gateway places payloadJSON content into raw.payload — no wrapper needed.
        return JsonSerializer.Serialize(new { format = rec.Format, base64 = rec.Base64, durationMs = rec.DurationMs, fps = rec.Fps, screenIndex = rec.ScreenIndex, hasAudio = rec.HasAudio });
    }

    private async Task<string> HandleSystemRunAsync(string paramsJson, string correlationId, CancellationToken ct)
    {
        var result = await _mediator.Send(new EvaluateExecRequestCommand(paramsJson, correlationId), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var cmd = result.Value;
        return JsonSerializer.Serialize(new { exitCode = cmd.ExitCode, stdout = cmd.Stdout, stderr = cmd.Stderr, durationMs = cmd.DurationMs });
    }

    private async Task<string> HandleSystemWhichAsync(string paramsJson, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(paramsJson);
        if (!doc.RootElement.TryGetProperty("name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("INVALID_PARAMS: name is required");
        var name = nameEl.GetString()!;
        var result = await _mediator.Send(new SystemWhichQuery(name), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var path = result.Value;
        return JsonSerializer.Serialize(new { found = path.IsFound, fullPath = path.FullPath, executableName = path.ExecutableName });
    }

    private async Task<string> HandleSystemNotifyAsync(string paramsJson, CancellationToken ct)
    {
        var result = await _mediator.Send(new SystemNotifyCommand(paramsJson), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return "{}";
    }

    private async Task<string> HandleGetExecApprovalsAsync(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetExecApprovalsQuery(), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return JsonSerializer.Serialize(result.Value, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        });
    }

    private async Task<string> HandleSetExecApprovalsAsync(string paramsJson, CancellationToken ct)
    {
        // Params: { file: ExecApprovalsFile, baseHash?: string }
        using var doc = JsonDocument.Parse(paramsJson);
        var fileJson = doc.RootElement.TryGetProperty("file", out var fileEl)
            ? fileEl.GetRawText()
            : paramsJson; // fallback: treat entire payload as file for backward compat
        var baseHash = doc.RootElement.TryGetProperty("baseHash", out var hashEl) ? hashEl.GetString() : null;

        var file = JsonSerializer.Deserialize<ExecApprovalsFile>(fileJson, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        }) ?? new ExecApprovalsFile { Version = 1 };

        var result = await _mediator.Send(new SetExecApprovalsCommand(file, baseHash), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");

        return JsonSerializer.Serialize(result.Value, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        });
    }

    private async Task<string> HandleLocationGetAsync(string paramsJson, CancellationToken ct)
    {
        // Parse params
        string? desiredAccuracy = null;
        int? maxAgeMs = null;
        int? timeoutMs = null;
        try
        {
            using var doc = JsonDocument.Parse(paramsJson);
            var root = doc.RootElement;
            if (root.TryGetProperty("desiredAccuracy", out var da) && da.ValueKind == JsonValueKind.String)
                desiredAccuracy = da.GetString();
            if (root.TryGetProperty("maxAgeMs", out var ma) && ma.ValueKind == JsonValueKind.Number)
                maxAgeMs = ma.GetInt32();
            if (root.TryGetProperty("timeoutMs", out var tm) && tm.ValueKind == JsonValueKind.Number)
                timeoutMs = tm.GetInt32();
        }
        catch { /* malformed JSON — use defaults, same as macOS OpenClawLocationGetParams() fallback */ }

        var result = await _mediator.Send(new GetLocationQuery(desiredAccuracy, maxAgeMs, timeoutMs), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var loc = result.Value;

        // Response field names and timestamp format must match OpenClawLocationPayload exactly
        var timestamp = DateTimeOffset.FromUnixTimeMilliseconds(loc.Timestamp)
            .ToUniversalTime()
            .ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        return JsonSerializer.Serialize(new
        {
            lat = loc.Latitude,
            lon = loc.Longitude,
            accuracyMeters = loc.Accuracy,
            altitudeMeters = loc.Altitude,
            speedMps = loc.Speed,
            headingDeg = loc.Heading,
            timestamp,
            isPrecise = loc.IsPrecise,
            source = (string?)null,
        }, new JsonSerializerOptions { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull });
    }

    private async Task<string> HandleCanvasPresentAsync(string paramsJson, CancellationToken ct)
    {
        var result = await _mediator.Send(new CanvasPresentCommand(paramsJson), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return "{}";
    }

    private async Task<string> HandleCanvasHideAsync(CancellationToken ct)
    {
        var result = await _mediator.Send(new CanvasHideCommand(), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return "{}";
    }

    private async Task<string> HandleCanvasNavigateAsync(string paramsJson, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(paramsJson);
        if (!doc.RootElement.TryGetProperty("url", out var urlEl) || urlEl.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("INVALID_PARAMS: url is required");
        var url = urlEl.GetString()!;
        var result = await _mediator.Send(new CanvasNavigateCommand(url), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return "{}";
    }

    private async Task<string> HandleCanvasEvalAsync(string paramsJson, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(paramsJson);
        // Gateway sends "javaScript" (canvas-tool.ts protocol name).
        if (!doc.RootElement.TryGetProperty("javaScript", out var scriptEl) || scriptEl.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("INVALID_PARAMS: javaScript is required");
        var script = scriptEl.GetString()!;
        var result = await _mediator.Send(new CanvasEvalCommand(script), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var eval = result.Value;
        return JsonSerializer.Serialize(new { success = eval.Success, result = eval.ResultJson, error = eval.Error });
    }

    private async Task<string> HandleCanvasSnapshotAsync(CancellationToken ct)
    {
        var result = await _mediator.Send(new CanvasSnapshotQuery(), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        var snap = result.Value;
        // Gateway places payloadJSON content into raw.payload (nodes.ts:1100).
        // parseCanvasSnapshotPayload expects { format, base64 } at the top level — no wrapper.
        // WebView2 CapturePreviewAsync only supports PNG.
        return JsonSerializer.Serialize(new { format = "png", base64 = snap.Base64 });
    }

    private async Task<string> HandleBrowserProxyAsync(string paramsJson, CancellationToken ct)
    {
        var result = await _mediator.Send(new BrowserProxyCommand(paramsJson), ct);
        if (result.IsError) throw new InvalidOperationException($"{result.FirstError.Code}: {result.FirstError.Description}");
        return result.Value;
    }

    private async Task<string> HandleA2UIAsync(string command, string paramsJson, CancellationToken ct)
    {
        // Execute JS directly on the canvas WebView via globalThis.openclawA2UI.
        if (command is "canvas.a2ui.reset" or "a2ui.reset")
        {
            var js = """
                (() => {
                  const host = globalThis.openclawA2UI;
                  if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
                  return JSON.stringify(host.reset());
                })()
                """;
            var evalResult = await _mediator.Send(new CanvasEvalCommand(js), ct);
            if (evalResult.IsError) throw new InvalidOperationException(evalResult.FirstError.Description);
            return evalResult.Value.ResultJson ?? "{}";
        }

        // canvas.a2ui.push / canvas.a2ui.pushJSONL — decode messages then applyMessages()
        string messagesJsonArray;
        using var doc = JsonDocument.Parse(paramsJson);
        var root = doc.RootElement;

        if (command is "canvas.a2ui.pushJSONL" or "a2ui.pushJSONL")
        {
            // JSONL: each line is a JSON object — parse into array
            if (!root.TryGetProperty("jsonl", out var jsonlEl) || jsonlEl.ValueKind != JsonValueKind.String)
                throw new InvalidOperationException("INVALID_PARAMS: jsonl is required");
            messagesJsonArray = ConvertJsonlToJsonArray(jsonlEl.GetString()!);
        }
        else
        {
            // Try messages array first, fall back to jsonl
            if (root.TryGetProperty("messages", out var msgs))
            {
                messagesJsonArray = msgs.GetRawText();
            }
            else if (root.TryGetProperty("jsonl", out var jl) && jl.ValueKind == JsonValueKind.String)
            {
                messagesJsonArray = ConvertJsonlToJsonArray(jl.GetString()!);
            }
            else
            {
                throw new InvalidOperationException("canvas.a2ui.push requires 'messages' or 'jsonl' param");
            }
        }

        var pushJs = $$"""
            (() => {
              try {
                const host = globalThis.openclawA2UI;
                if (!host) return JSON.stringify({ ok: false, error: "missing openclawA2UI" });
                const messages = {{messagesJsonArray}};
                return JSON.stringify(host.applyMessages(messages));
              } catch (e) {
                return JSON.stringify({ ok: false, error: String(e?.message ?? e) });
              }
            })()
            """;
        var pushResult = await _mediator.Send(new CanvasEvalCommand(pushJs), ct);
        if (pushResult.IsError) throw new InvalidOperationException(pushResult.FirstError.Description);
        return pushResult.Value.ResultJson ?? "{}";
    }

    // Converts JSONL (newline-delimited JSON) into a JSON array string.
    private static string ConvertJsonlToJsonArray(string jsonl)
    {
        var lines = jsonl.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var elements = new List<string>(lines.Length);
        foreach (var line in lines)
        {
            // Validate each line is valid JSON before including
            using var lineDoc = JsonDocument.Parse(line);
            elements.Add(line);
        }
        return "[" + string.Join(",", elements) + "]";
    }
}
