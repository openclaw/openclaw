namespace OpenClawWindows.Application.Sessions;

/// <summary>
/// Namespace for RPC operations and file-system utilities on a session.
/// UI dialogs (confirmDestructiveAction / presentError) are omitted here — they require
/// ContentDialog + XamlRoot and belong in the Presentation layer.
/// </summary>
public static class SessionActions
{
    // Equivalent of Swift's double-optional String??.
    // Absent  = don't include the field in the RPC params.
    // Set(null) = include with explicit null (clears the field server-side).
    // Set("v")  = include with the given string.
    public readonly struct NullableField
    {
        private NullableField(bool present, string? value) { IsSet = present; Value = value; }
        public bool IsSet { get; }
        public string? Value { get; }
        public static NullableField Absent => default;
        public static NullableField Clear => new(true, null);
        public static NullableField Of(string value) => new(true, value);
    }

    // RPC method names — exact gateway protocol strings
    private const string PatchMethod   = "sessions.patch";
    private const string ResetMethod   = "sessions.reset";
    private const string DeleteMethod  = "sessions.delete";
    private const string CompactMethod = "sessions.compact";

    // Tunables
    public const int  DefaultCompactMaxLines = 400;
    public const bool DeleteIncludesTranscript = true;

    // ── RPC actions ──────────────────────────────────────────────────────────

    // Patches mutable session fields.
    // thinking / verbose mirror Swift's String?? double-optional via NullableField.
    public static async Task PatchAsync(
        IGatewayRpcChannel channel,
        string key,
        NullableField thinking = default,
        NullableField verbose = default,
        CancellationToken ct = default)
    {
        var @params = new Dictionary<string, object?> { ["key"] = key };

        if (thinking.IsSet)
            @params["thinkingLevel"] = thinking.Value;

        if (verbose.IsSet)
            @params["verboseLevel"] = verbose.Value;

        await channel.RequestRawAsync(PatchMethod, @params, ct: ct);
    }

    // Resets the session context to its initial state.
    public static async Task ResetAsync(
        IGatewayRpcChannel channel,
        string key,
        CancellationToken ct = default)
        => await channel.RequestRawAsync(ResetMethod, new() { ["key"] = key }, ct: ct);

    // Permanently deletes the session and its transcript.
    public static async Task DeleteAsync(
        IGatewayRpcChannel channel,
        string key,
        CancellationToken ct = default)
        => await channel.RequestRawAsync(DeleteMethod,
            new() { ["key"] = key, ["deleteTranscript"] = DeleteIncludesTranscript }, ct: ct);

    // Compacts the session context, keeping only the most recent maxLines lines.
    public static async Task CompactAsync(
        IGatewayRpcChannel channel,
        string key,
        int maxLines = DefaultCompactMaxLines,
        CancellationToken ct = default)
        => await channel.RequestRawAsync(CompactMethod,
            new() { ["key"] = key, ["maxLines"] = (object?)maxLines }, ct: ct);

    // ── File utilities ────────────────────────────────────────────────────────

    // Opens the .jsonl session log in VS Code, falling back to Explorer selection.
    // Returns false when no log file was found (caller shows "not found" feedback).
    // Must be called on the UI thread (@MainActor equivalent).
    public static bool OpenSessionLogInEditor(string sessionId, string? storePath)
    {
        var existing = LogCandidates(sessionId, storePath).FirstOrDefault(File.Exists);
        if (existing is null)
            return false;

        // Equivalent to: /usr/bin/env code <path>
        if (TryOpenInVsCode(existing))
            return true;

        // Fallback: NSWorkspace.shared.activateFileViewerSelecting([url])
        RevealInExplorer(existing);
        return true;
    }

    private static IEnumerable<string> LogCandidates(string sessionId, string? storePath)
    {
        // Mirror macOS: first check store-relative dir, then fall back to state dir
        if (!string.IsNullOrEmpty(storePath))
        {
            var dir = Path.GetDirectoryName(storePath) ?? string.Empty;
            yield return Path.Combine(dir, $"{sessionId}.jsonl");
        }

        // %LOCALAPPDATA%\OpenClaw\sessions\
        var stateDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OpenClaw", "sessions");
        yield return Path.Combine(stateDir, $"{sessionId}.jsonl");
    }

    private static bool TryOpenInVsCode(string path)
    {
        try
        {
            using var proc = System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo
                {
                    FileName = "code",
                    Arguments = $"\"{path}\"",
                    UseShellExecute = true,
                });
            return proc is not null;
        }
        catch
        {
            return false;
        }
    }

    private static void RevealInExplorer(string path)
        // /select highlights the file in the parent folder, matching activateFileViewerSelecting
        => System.Diagnostics.Process.Start("explorer.exe", $"/select,\"{path}\"");
}
