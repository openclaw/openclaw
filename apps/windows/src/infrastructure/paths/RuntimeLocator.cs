using System.Diagnostics;
using System.Text.RegularExpressions;

namespace OpenClawWindows.Infrastructure.Paths;

public enum RuntimeKind { Node }

public readonly record struct RuntimeVersion(int Major, int Minor, int Patch)
    : IComparable<RuntimeVersion>
{
    public override string ToString() => $"{Major}.{Minor}.{Patch}";

    public int CompareTo(RuntimeVersion other)
    {
        if (Major != other.Major) return Major.CompareTo(other.Major);
        if (Minor != other.Minor) return Minor.CompareTo(other.Minor);
        return Patch.CompareTo(other.Patch);
    }

    public static bool operator <(RuntimeVersion l, RuntimeVersion r) => l.CompareTo(r) < 0;
    public static bool operator >(RuntimeVersion l, RuntimeVersion r) => l.CompareTo(r) > 0;
    public static bool operator <=(RuntimeVersion l, RuntimeVersion r) => l.CompareTo(r) <= 0;
    public static bool operator >=(RuntimeVersion l, RuntimeVersion r) => l.CompareTo(r) >= 0;

    private static readonly Regex VersionPattern = new(@"(\d+)\.(\d+)\.(\d+)", RegexOptions.Compiled);

    public static RuntimeVersion? From(string s)
    {
        var m = VersionPattern.Match(s);
        if (!m.Success) return null;
        return new RuntimeVersion(
            int.Parse(m.Groups[1].Value),
            int.Parse(m.Groups[2].Value),
            int.Parse(m.Groups[3].Value));
    }
}

public readonly record struct RuntimeResolution(RuntimeKind Kind, string Path, RuntimeVersion Version);

public abstract class RuntimeResolutionError
{
    public sealed class NotFound(IReadOnlyList<string> SearchPaths) : RuntimeResolutionError
    {
        public IReadOnlyList<string> SearchPaths { get; } = SearchPaths;
    }

    public sealed class Unsupported(
        RuntimeKind Kind,
        RuntimeVersion Found,
        RuntimeVersion Required,
        string Path,
        IReadOnlyList<string> SearchPaths) : RuntimeResolutionError
    {
        public RuntimeKind Kind { get; } = Kind;
        public RuntimeVersion Found { get; } = Found;
        public RuntimeVersion Required { get; } = Required;
        public string Path { get; } = Path;
        public IReadOnlyList<string> SearchPaths { get; } = SearchPaths;
    }

    public sealed class VersionParse(
        RuntimeKind Kind,
        string Raw,
        string Path,
        IReadOnlyList<string> SearchPaths) : RuntimeResolutionError
    {
        public RuntimeKind Kind { get; } = Kind;
        public string Raw { get; } = Raw;
        public string Path { get; } = Path;
        public IReadOnlyList<string> SearchPaths { get; } = SearchPaths;
    }
}

public readonly struct RuntimeLocatorResult
{
    public RuntimeResolution? Resolution { get; }
    public RuntimeResolutionError? Error { get; }
    public bool IsSuccess => Resolution is not null;

    private RuntimeLocatorResult(RuntimeResolution r) { Resolution = r; }
    private RuntimeLocatorResult(RuntimeResolutionError e) { Error = e; }

    public static RuntimeLocatorResult Ok(RuntimeResolution r) => new(r);
    public static RuntimeLocatorResult Fail(RuntimeResolutionError e) => new(e);
}

public static class RuntimeLocator
{
    private static readonly RuntimeVersion MinNode = new(22, 0, 0);

    // Default: split the system PATH by the Windows separator ';'
    public static string[] DefaultSearchPaths()
        => (Environment.GetEnvironmentVariable("PATH") ?? "")
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    public static RuntimeLocatorResult Resolve(
        string[]? searchPaths = null,
        Microsoft.Extensions.Logging.ILogger? logger = null)
    {
        var paths = searchPaths ?? DefaultSearchPaths();

        var binary = FindExecutable(paths);
        if (binary is null)
            return RuntimeLocatorResult.Fail(new RuntimeResolutionError.NotFound(paths));

        var rawVersion = ReadVersion(binary, paths, logger);
        if (rawVersion is null)
            return RuntimeLocatorResult.Fail(
                new RuntimeResolutionError.VersionParse(RuntimeKind.Node, "(unreadable)", binary, paths));

        var parsed = RuntimeVersion.From(rawVersion);
        if (parsed is null)
            return RuntimeLocatorResult.Fail(
                new RuntimeResolutionError.VersionParse(RuntimeKind.Node, rawVersion, binary, paths));

        if (parsed.Value < MinNode)
            return RuntimeLocatorResult.Fail(
                new RuntimeResolutionError.Unsupported(
                    RuntimeKind.Node, parsed.Value, MinNode, binary, paths));

        return RuntimeLocatorResult.Ok(new RuntimeResolution(RuntimeKind.Node, binary, parsed.Value));
    }

    public static string DescribeFailure(RuntimeResolutionError error)
    {
        return error switch
        {
            RuntimeResolutionError.NotFound e => string.Join('\n',
                "openclaw needs Node >=22.0.0 but found no runtime.",
                $"PATH searched: {string.Join(';', e.SearchPaths)}",
                "Install Node: https://nodejs.org/en/download"),
            RuntimeResolutionError.Unsupported e => string.Join('\n',
                $"Found {e.Kind.BinaryName()} {e.Found} at {e.Path} but need >= {e.Required}.",
                $"PATH searched: {string.Join(';', e.SearchPaths)}",
                "Upgrade Node and rerun openclaw."),
            RuntimeResolutionError.VersionParse e => string.Join('\n',
                $"Could not parse {e.Kind.BinaryName()} version output \"{e.Raw}\" from {e.Path}.",
                $"PATH searched: {string.Join(';', e.SearchPaths)}",
                "Try reinstalling or pinning a supported version (Node >=22.0.0)."),
            _ => "Unknown runtime resolution error.",
        };
    }

    // Searches candidate names in order: node.exe, node.cmd, node.bat
    private static readonly string[] NodeCandidateNames = ["node.exe", "node.cmd", "node.bat"];

    private static string? FindExecutable(string[] searchPaths)
    {
        foreach (var dir in searchPaths)
        {
            foreach (var name in NodeCandidateNames)
            {
                var candidate = System.IO.Path.Combine(dir, name);
                if (File.Exists(candidate))
                    return candidate;
            }
        }
        return null;
    }

    private static string? ReadVersion(string binary, string[] searchPaths, Microsoft.Extensions.Logging.ILogger? logger)
    {
        var start = Stopwatch.GetTimestamp();
        try
        {
            using var process = new Process();
            // .cmd/.bat files must be invoked through cmd.exe to capture output
            if (binary.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase)
                || binary.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
            {
                process.StartInfo.FileName = "cmd.exe";
                process.StartInfo.Arguments = $"/c \"{binary}\" --version";
            }
            else
            {
                process.StartInfo.FileName = binary;
                process.StartInfo.Arguments = "--version";
            }

            process.StartInfo.RedirectStandardOutput = true;
            process.StartInfo.RedirectStandardError = true;
            process.StartInfo.UseShellExecute = false;
            process.StartInfo.CreateNoWindow = true;
            // Pass the search paths as PATH so node can find its own modules
            process.StartInfo.Environment["PATH"] = string.Join(';', searchPaths);

            process.Start();
            var output = process.StandardOutput.ReadToEnd()
                + process.StandardError.ReadToEnd();
            process.WaitForExit();

            var elapsedMs = (int)(Stopwatch.GetElapsedTime(start).TotalMilliseconds);
            if (elapsedMs > 500)
                logger?.LogWarning("runtime --version slow ({ElapsedMs}ms) bin={Binary}", elapsedMs, binary);
            else
                logger?.LogDebug("runtime --version ok ({ElapsedMs}ms) bin={Binary}", elapsedMs, binary);

            return output.Trim();
        }
        catch (Exception ex)
        {
            var elapsedMs = (int)(Stopwatch.GetElapsedTime(start).TotalMilliseconds);
            logger?.LogError("runtime --version failed ({ElapsedMs}ms) bin={Binary} err={Error}",
                elapsedMs, binary, ex.Message);
            return null;
        }
    }
}

public static class RuntimeKindExtensions
{
    public static string BinaryName(this RuntimeKind kind) => kind switch
    {
        RuntimeKind.Node => "node",
        _ => kind.ToString().ToLowerInvariant(),
    };
}
