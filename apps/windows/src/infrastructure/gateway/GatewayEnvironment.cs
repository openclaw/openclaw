using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using ILogger = Microsoft.Extensions.Logging.ILogger;
using OpenClawWindows.Domain.Config;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure.Paths;

namespace OpenClawWindows.Infrastructure.Gateway;

internal readonly record struct Semver(int Major, int Minor, int Patch)
    : IComparable<Semver>
{
    public override string ToString() => $"{Major}.{Minor}.{Patch}";

    public int CompareTo(Semver other)
    {
        if (Major != other.Major) return Major.CompareTo(other.Major);
        if (Minor != other.Minor) return Minor.CompareTo(other.Minor);
        return Patch.CompareTo(other.Patch);
    }

    public static bool operator <(Semver l, Semver r)  => l.CompareTo(r) < 0;
    public static bool operator >(Semver l, Semver r)  => l.CompareTo(r) > 0;
    public static bool operator <=(Semver l, Semver r) => l.CompareTo(r) <= 0;
    public static bool operator >=(Semver l, Semver r) => l.CompareTo(r) >= 0;

    internal static Semver? Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var cleaned = raw.Trim();
        // Strip leading "v" prefix (regex ^v → simple char check)
        if (cleaned.StartsWith('v') || cleaned.StartsWith('V'))
            cleaned = cleaned[1..];

        var parts = cleaned.Split('.');
        if (parts.Length < 3) return null;
        if (!int.TryParse(parts[0], out var major)) return null;
        if (!int.TryParse(parts[1], out var minor)) return null;

        // Strip prerelease suffix separated by '-' or '+'
        var patchToken = parts[2].Split(['-', '+'], 2)[0];
        if (!int.TryParse(patchToken, out var patch)) return null;

        return new Semver(major, minor, patch);
    }

    internal bool Compatible(Semver required) =>
        Major == required.Major && this >= required;
}

internal abstract class GatewayEnvironmentKind
{
    internal sealed class Checking                                         : GatewayEnvironmentKind { }
    internal sealed class Ok                                               : GatewayEnvironmentKind { }
    internal sealed class MissingNode                                      : GatewayEnvironmentKind { }
    internal sealed class MissingGateway                                   : GatewayEnvironmentKind { }
    internal sealed class Incompatible(string Found, string Required)     : GatewayEnvironmentKind
    {
        internal string Found    { get; } = Found;
        internal string Required { get; } = Required;
    }
    internal sealed class Error(string Message)                            : GatewayEnvironmentKind
    {
        internal string Message { get; } = Message;
    }
}

internal sealed record GatewayEnvironmentStatus(
    GatewayEnvironmentKind Kind,
    string? NodeVersion,
    string? GatewayVersion,
    string? RequiredGateway,
    string Message)
{
    internal static GatewayEnvironmentStatus Checking =>
        new(new GatewayEnvironmentKind.Checking(), null, null, null, "Checking\u2026");
}

internal sealed record GatewayCommandResolution(
    GatewayEnvironmentStatus Status,
    string[]? Command);

/// <summary>
/// Validates the Node.js runtime and gateway binary; resolves the gateway launch command.
/// </summary>
internal static class GatewayEnvironment
{
    // Tunables
    private const int DefaultGatewayPort = 18789;
    private const int VersionProbeTimeoutMs = 3_000; // 3 s slow-check threshold

    private static readonly HashSet<string> SupportedBindModes =
        ["loopback", "tailnet", "lan", "auto"];

    // (UserDefaults "gatewayPort" step omitted — no equivalent integer stored in Windows AppSettings.)
    internal static int GatewayPort()
    {
        var envRaw = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_PORT")?.Trim();
        if (envRaw is not null && int.TryParse(envRaw, out var envPort) && envPort > 0)
            return envPort;

        var configPort = OpenClawConfigFile.GatewayPort();
        if (configPort is > 0) return configPort.Value;

        return DefaultGatewayPort;
    }

    internal static string? ExpectedGatewayVersionString()
    {
        var v = Assembly.GetExecutingAssembly().GetName().Version;
        if (v is null) return null;
        var s = v.ToString(3).Trim();
        return s.Length > 0 ? s : null;
    }

    internal static Semver? ExpectedGatewayVersion() =>
        Semver.Parse(ExpectedGatewayVersionString());

    internal static Semver? ExpectedGatewayVersion(string? versionString) =>
        Semver.Parse(versionString);

    internal static GatewayEnvironmentStatus Check(ILogger? logger = null)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            return DoCheck(logger);
        }
        finally
        {
            sw.Stop();
            var ms = (int)sw.ElapsedMilliseconds;
            if (ms > 500)
                logger?.LogWarning("gateway env check slow ({ElapsedMs}ms)", ms);
            else
                logger?.LogDebug("gateway env check ok ({ElapsedMs}ms)", ms);
        }
    }

    internal static GatewayCommandResolution ResolveGatewayCommand(
        AppSettings? settings = null,
        ILogger? logger = null)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            return DoResolveGatewayCommand(settings, logger);
        }
        finally
        {
            sw.Stop();
            var ms = (int)sw.ElapsedMilliseconds;
            if (ms > 500)
                logger?.LogWarning("gateway command resolve slow ({ElapsedMs}ms)", ms);
            else
                logger?.LogDebug("gateway command resolve ok ({ElapsedMs}ms)", ms);
        }
    }

    internal static async Task InstallGlobal(
        string? versionString,
        Action<string> statusHandler,
        CancellationToken ct = default)
    {
        var target = versionString?.Trim() is { Length: > 0 } v ? v : "latest";
        var searchPaths = RuntimeLocator.DefaultSearchPaths();

        var (label, cmd) = FindPackageManager(searchPaths) switch
        {
            ("npm",  var npm)  => ("npm",  new[] { npm,  "install", "-g", $"openclaw@{target}" }),
            ("pnpm", var pnpm) => ("pnpm", new[] { pnpm, "add",     "-g", $"openclaw@{target}" }),
            ("bun",  var bun)  => ("bun",  new[] { bun,  "add",     "-g", $"openclaw@{target}" }),
            _                  => ("npm",  new[] { "npm", "install", "-g", $"openclaw@{target}" }),
        };

        statusHandler($"Installing openclaw@{target} via {label}\u2026");

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(300)); // 300 s timeout

            using var proc = new Process();
            proc.StartInfo.FileName  = cmd[0];
            for (var i = 1; i < cmd.Length; i++)
                proc.StartInfo.ArgumentList.Add(cmd[i]);

            proc.StartInfo.RedirectStandardOutput = true;
            proc.StartInfo.RedirectStandardError  = true;
            proc.StartInfo.UseShellExecute        = false;
            proc.StartInfo.CreateNoWindow         = true;

            proc.Start();
            var stdout = await proc.StandardOutput.ReadToEndAsync(cts.Token).ConfigureAwait(false);
            var stderr = await proc.StandardError.ReadToEndAsync(cts.Token).ConfigureAwait(false);
            await proc.WaitForExitAsync(cts.Token).ConfigureAwait(false);

            if (proc.ExitCode == 0)
            {
                statusHandler($"Installed openclaw@{target}");
            }
            else
            {
                var summary = Summarize(stderr) ?? Summarize(stdout);
                var exit = $"exit {proc.ExitCode}";
                statusHandler(summary is not null
                    ? $"Install failed ({exit}): {summary}"
                    : $"Install failed ({exit})");
            }
        }
        catch (OperationCanceledException)
        {
            statusHandler("Install failed: timed out. Check your internet connection and try again.");
        }
        catch (Exception ex)
        {
            statusHandler($"Install failed: {ex.Message}");
        }
    }

    // ── Internal helpers exposed for testing ───────────────────────────────────

    internal static string? PreferredGatewayBind(AppSettings? settings = null)
    {
        // Remote mode → no bind flag (gateway runs on the remote host)
        if (settings?.ConnectionMode == ConnectionMode.Remote)
            return null;

        var envBind = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_BIND")
            ?.Trim()
            .ToLowerInvariant();
        if (envBind is not null && SupportedBindModes.Contains(envBind))
            return envBind;

        var root    = OpenClawConfigFile.LoadDict();
        var gateway = root.GetValueOrDefault("gateway") as Dictionary<string, object?>;
        var cfgBind = (gateway?.GetValueOrDefault("bind") as string)
            ?.Trim()
            .ToLowerInvariant();
        if (cfgBind is not null && SupportedBindModes.Contains(cfgBind))
            return cfgBind;

        return null;
    }

    internal static Semver? ReadLocalGatewayVersion(string projectRoot)
    {
        var pkg = Path.Combine(projectRoot, "package.json");
        if (!File.Exists(pkg)) return null;
        try
        {
            var text = File.ReadAllText(pkg);
            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("version", out var vProp)) return null;
            return Semver.Parse(vProp.GetString());
        }
        catch { return null; }
    }

    // ── Private helpers ────────────────────────────────────────────────────────

    private static GatewayEnvironmentStatus DoCheck(ILogger? logger)
    {
        var expected       = ExpectedGatewayVersion();
        var expectedString = ExpectedGatewayVersionString();
        var projectRoot    = GatewayProjectRoot();
        var entrypoint     = GatewayEntrypoint(projectRoot);

        // Resolve Node runtime
        var runtimeResult = RuntimeLocator.Resolve(logger: logger);
        if (!runtimeResult.IsSuccess)
        {
            return new GatewayEnvironmentStatus(
                new GatewayEnvironmentKind.MissingNode(),
                null, null, expectedString,
                RuntimeLocator.DescribeFailure(runtimeResult.Error!));
        }

        var runtime    = runtimeResult.Resolution!.Value;
        var gatewayBin = FindOpenClawExecutable();

        if (gatewayBin is null && entrypoint is null)
        {
            return new GatewayEnvironmentStatus(
                new GatewayEnvironmentKind.MissingGateway(),
                runtime.Version.ToString(), null, expectedString,
                "openclaw CLI not found in PATH; install via: npm install -g openclaw");
        }

        // Read installed gateway version — prefer global binary, fall back to local package.json
        var installed = (gatewayBin is not null ? ReadGatewayVersion(gatewayBin, logger) : null)
                        ?? ReadLocalGatewayVersion(projectRoot);

        if (expected.HasValue && installed.HasValue && !installed.Value.Compatible(expected.Value))
        {
            var expectedText = expectedString ?? expected.Value.ToString();
            return new GatewayEnvironmentStatus(
                new GatewayEnvironmentKind.Incompatible(installed.Value.ToString(), expectedText),
                runtime.Version.ToString(), installed.Value.ToString(), expectedText,
                $"Gateway version {installed.Value} is incompatible with app {expectedText}; "
                + "install or update the global package.");
        }

        var label            = gatewayBin is not null ? "global" : "local";
        var gatewayLabel     = gatewayBin is not null ? $"({label})"
            : entrypoint is not null ? $"(local: {entrypoint})" : "(local)";
        var gatewayVersionText = installed?.ToString() ?? "unknown";

        return new GatewayEnvironmentStatus(
            new GatewayEnvironmentKind.Ok(),
            runtime.Version.ToString(), gatewayVersionText, expectedString,
            $"Node {runtime.Version}; gateway {gatewayVersionText} {gatewayLabel}");
    }

    private static GatewayCommandResolution DoResolveGatewayCommand(
        AppSettings? settings,
        ILogger? logger)
    {
        var status = Check(logger);
        if (status.Kind is not GatewayEnvironmentKind.Ok)
            return new GatewayCommandResolution(status, null);

        var port       = GatewayPort();
        var bind       = PreferredGatewayBind(settings) ?? "loopback";
        var projectRoot = GatewayProjectRoot();
        var entrypoint  = GatewayEntrypoint(projectRoot);
        var gatewayBin  = FindOpenClawExecutable();

        if (gatewayBin is not null)
        {
            var cmd = new[] { gatewayBin, "gateway", "--port", $"{port}", "--bind", bind, "--allow-unconfigured" };
            return new GatewayCommandResolution(status, cmd);
        }

        var runtimeResult = RuntimeLocator.Resolve(logger: logger);
        if (entrypoint is not null && runtimeResult.IsSuccess)
        {
            var rt  = runtimeResult.Resolution!.Value;
            var cmd = new[] { rt.Path, entrypoint, "gateway", "--port", $"{port}", "--bind", bind, "--allow-unconfigured" };
            return new GatewayCommandResolution(status, cmd);
        }

        return new GatewayCommandResolution(status, null);
    }

    private static Semver? ReadGatewayVersion(string binary, ILogger? logger)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            using var proc = new Process();
            // .cmd files need cmd.exe on Windows
            if (binary.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                || binary.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
            {
                proc.StartInfo.FileName = "cmd.exe";
                proc.StartInfo.Arguments = $"/c \"{binary}\" --version";
            }
            else
            {
                proc.StartInfo.FileName = binary;
                proc.StartInfo.Arguments = "--version";
            }

            proc.StartInfo.RedirectStandardOutput = true;
            proc.StartInfo.RedirectStandardError  = true;
            proc.StartInfo.UseShellExecute        = false;
            proc.StartInfo.CreateNoWindow         = true;

            proc.Start();

            // Read with timeout
            var outTask = proc.StandardOutput.ReadToEndAsync();
            var errTask = proc.StandardError.ReadToEndAsync();
            var exited  = proc.WaitForExit(VersionProbeTimeoutMs);
            if (!exited)
            {
                try { proc.Kill(); } catch { }
            }

            var raw  = (outTask.IsCompleted ? outTask.Result : "") + (errTask.IsCompleted ? errTask.Result : "");
            var ms   = (int)sw.ElapsedMilliseconds;
            if (ms > 500)
                logger?.LogWarning("gateway --version slow ({ElapsedMs}ms) bin={Binary}", ms, binary);
            else
                logger?.LogDebug("gateway --version ok ({ElapsedMs}ms) bin={Binary}", ms, binary);

            return Semver.Parse(raw.Trim());
        }
        catch (Exception ex)
        {
            logger?.LogError("gateway --version failed ({ElapsedMs}ms) bin={Binary} err={Error}",
                (int)sw.ElapsedMilliseconds, binary, ex.Message);
            return null;
        }
    }

    private static string? FindOpenClawExecutable()
    {
        // 1. Common npm global install locations (npm install -g places .cmd wrappers here)
        var appData      = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string[] priority = [
            Path.Combine(appData,      "npm", "openclaw.cmd"),
            Path.Combine(localAppData, "npm", "openclaw.cmd"),
        ];
        foreach (var c in priority)
            if (File.Exists(c)) return c;

        // 2. Walk PATH — handles nvm-windows, volta, pnpm global bin, etc.
        foreach (var dir in RuntimeLocator.DefaultSearchPaths())
        {
            foreach (var name in new[] { "openclaw.cmd", "openclaw.exe", "openclaw" })
            {
                var candidate = Path.Combine(dir, name);
                if (File.Exists(candidate)) return candidate;
            }
        }

        return null;
    }

    private static string? GatewayEntrypoint(string root)
    {
        string[] candidates = [
            Path.Combine(root, "dist", "index.js"),
            Path.Combine(root, "openclaw.mjs"),
            Path.Combine(root, "bin", "openclaw.js"),
        ];
        return candidates.FirstOrDefault(File.Exists);
    }

    private static string GatewayProjectRoot()
    {
        var env = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_PROJECT_ROOT")?.Trim();
        if (!string.IsNullOrEmpty(env) && Directory.Exists(env)) return env;

        var fallback = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Projects", "openclaw");
        return Directory.Exists(fallback) ? fallback
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    private static (string Name, string Path)? FindPackageManager(string[] searchPaths)
    {
        string[][] candidates = [
            ["npm",  "npm.cmd",  "npm.exe",  "npm"],
            ["pnpm", "pnpm.cmd", "pnpm.exe", "pnpm"],
            ["bun",  "bun.exe",  "bun.cmd",  "bun"],
        ];
        foreach (var group in candidates)
        {
            var label = group[0];
            foreach (var dir in searchPaths)
            {
                foreach (var name in group[1..])
                {
                    var path = Path.Combine(dir, name);
                    if (File.Exists(path)) return (label, path);
                }
            }
        }
        return null;
    }

    private static string? Summarize(string text)
    {
        var last = text
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .LastOrDefault(l => l.Length > 0);
        if (last is null) return null;
        // Collapse runs of whitespace
        var normalized = System.Text.RegularExpressions.Regex.Replace(last, @"\s+", " ");
        return normalized.Length > 200 ? normalized[..199] + "\u2026" : normalized;
    }
}
