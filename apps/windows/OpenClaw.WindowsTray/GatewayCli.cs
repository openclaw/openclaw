using System.Diagnostics;
using System.Text.Json;

namespace OpenClaw.WindowsTray;

internal enum GatewayTrayState
{
    Unknown,
    Running,
    Stopped,
    Degraded,
}

internal sealed record CliSmokeResult(
    bool Ok,
    string Command,
    string State,
    string Summary,
    string? Details,
    string? LogsDirectory,
    string? RecommendedAction,
    string? Error
);

internal sealed record GatewayStatusSnapshot(
    GatewayTrayState State,
    string Summary,
    string? Details,
    string? LogsDirectory,
    string? ConfigDirectory,
    string? RecommendedAction
);

internal sealed record GatewayLifecycleResult(
    bool Ok,
    string Summary,
    string? Details
);

internal sealed record CliInvocation(
    string FileName,
    string? ShellCommand,
    string WorkingDirectory,
    string DisplayCommand
)
{
    public ProcessStartInfo CreateProcessStartInfo(IEnumerable<string> args)
    {
        if (!string.IsNullOrEmpty(ShellCommand))
        {
            var renderedCommand = RenderCommand(ShellCommand, args);
            return new ProcessStartInfo
            {
                FileName = FileName,
                WorkingDirectory = WorkingDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                Arguments = renderedCommand,
            };
        }

        var psi = new ProcessStartInfo
        {
            FileName = FileName,
            WorkingDirectory = WorkingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var arg in args)
        {
            psi.ArgumentList.Add(arg);
        }
        return psi;
    }

    private static string RenderCommand(string shellCommand, IEnumerable<string> args)
    {
        var renderedArgs = string.Join(" ", args.Select(QuoteArgument));
        var fullCommand = string.IsNullOrWhiteSpace(renderedArgs)
            ? shellCommand
            : $"{shellCommand} {renderedArgs}";
        return $"/d /s /c \"{fullCommand}\"";
    }

    private static string QuoteArgument(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }

        if (!value.Any(char.IsWhiteSpace) && !value.Contains('"'))
        {
            return value;
        }

        return $"\"{value.Replace("\"", "\\\"")}\"";
    }
}

internal static class GatewayCli
{
    private static readonly TimeSpan CliTimeout = TimeSpan.FromSeconds(45);

    private const string OpenClawDocsUrl = "https://docs.openclaw.ai/platforms/windows";
    private const string OpenClawTroubleshootingUrl =
      "https://docs.openclaw.ai/platforms/windows-troubleshooting";

    private static readonly Lazy<CliInvocation> Invocation = new(ResolveInvocation);

    public static string DocsUrl => OpenClawDocsUrl;

    public static string TroubleshootingUrl => OpenClawTroubleshootingUrl;

    public static string DisplayCommand => Invocation.Value.DisplayCommand;

    public static string ResolveConfigDirectory(string? logsDirectory)
    {
        if (!string.IsNullOrWhiteSpace(logsDirectory))
        {
            var parent = Directory.GetParent(logsDirectory);
            if (parent is not null)
            {
                return parent.FullName;
            }
        }

        var overrideStateDir = Environment.GetEnvironmentVariable("OPENCLAW_STATE_DIR");
        if (!string.IsNullOrWhiteSpace(overrideStateDir))
        {
            return overrideStateDir;
        }

        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return Path.Combine(userProfile, ".openclaw");
    }

    public static async Task<CliSmokeResult> RunSmokeAsync()
    {
        try
        {
            var status = await GetStatusAsync();
            return new CliSmokeResult(
                true,
                Invocation.Value.DisplayCommand,
                status.State.ToString().ToLowerInvariant(),
                status.Summary,
                status.Details,
                status.LogsDirectory,
                status.RecommendedAction,
                null
            );
        }
        catch (Exception ex)
        {
            return new CliSmokeResult(
                false,
                Invocation.Value.DisplayCommand,
                "error",
                "Tray smoke check failed.",
                null,
                null,
                null,
                ex.Message
            );
        }
    }

    public static async Task<GatewayStatusSnapshot> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var result = await InvokeJsonAsync(new[] { "gateway", "status", "--json" }, cancellationToken);
        if (!result.Ok)
        {
            return CreateCliFailureSnapshot(result.ErrorText);
        }

        using var document = ParseStatusDocument(result.StdOut);
        var root = document.RootElement;
        var serviceLoaded = TryGetBoolean(root, "service", "loaded");
        var runtimeStatus = TryGetString(root, "service", "runtime", "status");
        var rpcOk = TryGetBoolean(root, "rpc", "ok");
        var degradedReason = TryGetString(root, "windows", "degradedReason");
        var recommendedAction = TryGetString(root, "windows", "recommendedAction")
            ?? TryGetString(root, "windows", "wsl", "recommendedAction");
        var registrationDetail = TryGetString(root, "windows", "registrationDetail");
        var logsDirectory = TryGetString(root, "logs", "directory");
        var configDirectory = ResolveConfigDirectory(logsDirectory);

        var state = GatewayTrayState.Unknown;
        var summary = "Gateway status is not available yet.";

        if (!string.IsNullOrWhiteSpace(degradedReason))
        {
            state = GatewayTrayState.Degraded;
            summary = degradedReason;
        }
        else if (serviceLoaded == false || string.Equals(runtimeStatus, "stopped", StringComparison.OrdinalIgnoreCase))
        {
            state = GatewayTrayState.Stopped;
            summary = "Gateway is stopped.";
        }
        else if (string.Equals(runtimeStatus, "running", StringComparison.OrdinalIgnoreCase) && rpcOk == false)
        {
            state = GatewayTrayState.Degraded;
            summary = "Gateway process is running, but the health probe is failing.";
        }
        else if (string.Equals(runtimeStatus, "running", StringComparison.OrdinalIgnoreCase))
        {
            state = GatewayTrayState.Running;
            summary = "Gateway is running.";
        }
        else if (serviceLoaded == true)
        {
            state = GatewayTrayState.Degraded;
            summary = "Gateway startup is registered, but runtime details are incomplete.";
        }

        var detailsParts = new List<string>();
        if (!string.IsNullOrWhiteSpace(registrationDetail))
        {
            detailsParts.Add(registrationDetail);
        }

        var wslState = TryGetBoolean(root, "windows", "wsl", "wslExeAvailable") switch
        {
            false => "WSL2 not installed",
            true when TryGetBoolean(root, "windows", "wsl", "defaultDistroReachable") == false =>
                "WSL2 installed, distro not ready",
            true when TryGetBoolean(root, "windows", "wsl", "systemdEnabled") == false =>
                "WSL2 reachable, systemd disabled",
            true => "WSL2 ready",
            _ => null,
        };
        if (!string.IsNullOrWhiteSpace(wslState))
        {
            detailsParts.Add(wslState);
        }

        return new GatewayStatusSnapshot(
            state,
            summary,
            detailsParts.Count > 0 ? string.Join(" | ", detailsParts) : null,
            logsDirectory,
            configDirectory,
            recommendedAction
        );
    }

    private static JsonDocument ParseStatusDocument(string rawJson)
    {
        try
        {
            return JsonDocument.Parse(rawJson);
        }
        catch (JsonException ex)
        {
            throw new InvalidOperationException(
                $"The OpenClaw CLI returned invalid JSON for `gateway status --json`: {ex.Message}",
                ex
            );
        }
    }

    private static GatewayStatusSnapshot CreateCliFailureSnapshot(string? errorText)
    {
        var detail = string.IsNullOrWhiteSpace(errorText) ? "No CLI error output was captured." : errorText.Trim();
        var configDirectory = ResolveConfigDirectory(null);

        if (detail.Contains("Timed out after", StringComparison.OrdinalIgnoreCase))
        {
            return new GatewayStatusSnapshot(
                GatewayTrayState.Degraded,
                "OpenClaw CLI timed out while reading gateway status.",
                detail,
                null,
                configDirectory,
                "Run `openclaw gateway status --json` manually. If it hangs, inspect `openclaw doctor` and restart the gateway."
            );
        }

        if (
            detail.Contains("Could not find the `openclaw` CLI", StringComparison.OrdinalIgnoreCase)
            || detail.Contains("not recognized", StringComparison.OrdinalIgnoreCase)
            || detail.Contains("No such file", StringComparison.OrdinalIgnoreCase)
        )
        {
            return new GatewayStatusSnapshot(
                GatewayTrayState.Degraded,
                "OpenClaw CLI is not available to the tray app.",
                detail,
                null,
                configDirectory,
                "Install OpenClaw or set OPENCLAW_TRAY_OPENCLAW_PATH to a working `openclaw.cmd` or `openclaw.exe`."
            );
        }

        return new GatewayStatusSnapshot(
            GatewayTrayState.Degraded,
            "OpenClaw CLI could not read gateway status.",
            detail,
            null,
            configDirectory,
            "Install or expose the `openclaw` CLI, then retry."
        );
    }

    public static async Task<GatewayLifecycleResult> RunLifecycleAsync(
        string action,
        CancellationToken cancellationToken = default
    )
    {
        var result = await InvokeJsonAsync(new[] { "gateway", action, "--json" }, cancellationToken);
        if (!result.Ok)
        {
            return new GatewayLifecycleResult(false, $"Gateway {action} failed.", result.ErrorText);
        }

        using var document = JsonDocument.Parse(result.StdOut);
        var root = document.RootElement;
        var ok = root.TryGetProperty("ok", out var okElement) && okElement.GetBoolean();
        var summary = TryGetString(root, "message")
            ?? TryGetString(root, "result")
            ?? (ok ? $"Gateway {action} completed." : $"Gateway {action} failed.");
        var details = TryGetString(root, "error");
        if (string.IsNullOrWhiteSpace(details))
        {
            details = TryGetString(root, "warnings");
        }
        return new GatewayLifecycleResult(ok, summary, details);
    }

    private static async Task<(bool Ok, string StdOut, string ErrorText)> InvokeJsonAsync(
        IEnumerable<string> args,
        CancellationToken cancellationToken
    )
    {
        var invocation = Invocation.Value;
        using var process = new Process
        {
            StartInfo = invocation.CreateProcessStartInfo(args),
        };

        var started = process.Start();
        if (!started)
        {
            return (false, string.Empty, "Failed to start the OpenClaw CLI process.");
        }

        var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
        var exitTask = process.WaitForExitAsync(cancellationToken);
        var timeoutTask = Task.Delay(CliTimeout, cancellationToken);
        var completed = await Task.WhenAny(exitTask, timeoutTask);
        if (completed == timeoutTask && !process.HasExited)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best effort only.
            }

            return (
                false,
                string.Empty,
                $"Timed out after {CliTimeout.TotalSeconds:0} seconds while running `{invocation.DisplayCommand} {string.Join(" ", args)}`."
            );
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        return (process.ExitCode == 0, stdout, string.IsNullOrWhiteSpace(stderr) ? stdout : stderr);
    }

    private static CliInvocation ResolveInvocation()
    {
        var overridePath = Environment.GetEnvironmentVariable("OPENCLAW_TRAY_OPENCLAW_PATH");
        if (!string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath))
        {
            return CreateInvocation(overridePath, Environment.CurrentDirectory, overridePath);
        }

        foreach (var candidate in new[] { "openclaw.cmd", "openclaw.exe", "openclaw" })
        {
            var resolved = ResolveCommandFromPath(candidate);
            if (!string.IsNullOrWhiteSpace(resolved))
            {
                return CreateInvocation(resolved, Environment.CurrentDirectory, resolved);
            }
        }

        var repoRoot = TryFindRepoRoot();
        if (!string.IsNullOrWhiteSpace(repoRoot))
        {
            var nodePath = ResolveCommandFromPath("node.exe") ?? ResolveCommandFromPath("node");
            if (!string.IsNullOrWhiteSpace(nodePath))
            {
                var builtCliPath = Path.Combine(repoRoot, "dist", "index.js");
                if (File.Exists(builtCliPath))
                {
                    return CreateInvocation(
                        nodePath,
                        repoRoot,
                        "node dist/index.js",
                        "dist/index.js"
                    );
                }

                return CreateInvocation(
                    nodePath,
                    repoRoot,
                    "node scripts/run-node.mjs",
                    "scripts/run-node.mjs"
                );
            }

            foreach (var pnpmCandidate in new[] { "pnpm.cmd", "pnpm.exe", "pnpm" })
            {
                var pnpmPath = ResolveCommandFromPath(pnpmCandidate);
                if (!string.IsNullOrWhiteSpace(pnpmPath))
                {
                    return CreateInvocation(
                        pnpmPath,
                        repoRoot,
                        $"{pnpmPath} openclaw",
                        "openclaw"
                    );
                }
            }
        }

        throw new InvalidOperationException(
            "Could not find the `openclaw` CLI. Install OpenClaw first or set OPENCLAW_TRAY_OPENCLAW_PATH."
        );
    }

    private static CliInvocation CreateInvocation(
        string commandPath,
        string workingDirectory,
        string displayCommand,
        params string[] shellPrefix
    )
    {
        var needsShell = commandPath.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
            || commandPath.EndsWith(".bat", StringComparison.OrdinalIgnoreCase);
        if (needsShell)
        {
            var commandText = string.Join(
                " ",
                new[] { QuoteShellToken(commandPath) }.Concat(shellPrefix.Select(QuoteShellToken))
            );
            return new CliInvocation("cmd.exe", commandText, workingDirectory, displayCommand);
        }

        if (shellPrefix.Length > 0)
        {
            var commandText = string.Join(
                " ",
                new[] { QuoteShellToken(commandPath) }.Concat(shellPrefix.Select(QuoteShellToken))
            );
            return new CliInvocation("cmd.exe", commandText, workingDirectory, displayCommand);
        }

        return new CliInvocation(commandPath, null, workingDirectory, displayCommand);
    }

    private static string QuoteShellToken(string token)
    {
        return token.Any(char.IsWhiteSpace) ? $"\"{token}\"" : token;
    }

    private static string? ResolveCommandFromPath(string candidate)
    {
        try
        {
            using var process = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = candidate,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                },
            };
            if (!process.Start())
            {
                return null;
            }

            var stdout = process.StandardOutput.ReadToEnd();
            process.WaitForExit(5000);
            if (process.ExitCode != 0)
            {
                return null;
            }

            return stdout
                .Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(line => line.Trim())
                .FirstOrDefault(line => !string.IsNullOrWhiteSpace(line));
        }
        catch
        {
            return null;
        }
    }

    private static string? TryFindRepoRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            var packageJson = Path.Combine(current.FullName, "package.json");
            if (File.Exists(packageJson))
            {
                var raw = File.ReadAllText(packageJson);
                if (raw.Contains("\"name\": \"openclaw\"", StringComparison.Ordinal))
                {
                    return current.FullName;
                }
            }
            current = current.Parent;
        }

        return null;
    }

    private static bool? TryGetBoolean(JsonElement root, params string[] path)
    {
        if (!TryGetElement(root, path, out var current) || current.ValueKind != JsonValueKind.True && current.ValueKind != JsonValueKind.False)
        {
            return null;
        }

        return current.GetBoolean();
    }

    private static string? TryGetString(JsonElement root, params string[] path)
    {
        if (!TryGetElement(root, path, out var current))
        {
            return null;
        }

        return current.ValueKind switch
        {
            JsonValueKind.String => current.GetString(),
            JsonValueKind.Array => string.Join(
                ", ",
                current.EnumerateArray()
                    .Where(item => item.ValueKind == JsonValueKind.String)
                    .Select(item => item.GetString())
                    .Where(item => !string.IsNullOrWhiteSpace(item))
            ),
            _ => null,
        };
    }

    private static bool TryGetElement(JsonElement root, IEnumerable<string> path, out JsonElement current)
    {
        current = root;
        foreach (var segment in path)
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return false;
            }
        }

        return true;
    }
}
