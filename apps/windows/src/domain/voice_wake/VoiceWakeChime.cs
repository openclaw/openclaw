namespace OpenClawWindows.Domain.VoiceWake;

/// <summary>
/// discriminated union for chime configuration —
/// none (silent), system sound by name, or user-picked custom file.
/// </summary>
internal abstract record VoiceWakeChime
{
    internal sealed record None : VoiceWakeChime;

    internal sealed record SystemSound(string Name) : VoiceWakeChime;

    // Bookmark stores a platform-encoded file reference (DPAPI-encrypted path on Windows).
    internal sealed record Custom(string DisplayName, byte[] Bookmark) : VoiceWakeChime;

    internal string? SystemName => this is SystemSound s ? s.Name : null;

    internal string DisplayLabel => this switch
    {
        None                      => "No Sound",
        SystemSound s             => VoiceWakeChimeCatalog.DisplayName(s.Name),
        Custom(var displayName, _) => displayName,
        _                         => throw new InvalidOperationException("Unknown VoiceWakeChime case"),
    };
}

internal static class VoiceWakeChimeCatalog
{
    // Windows equivalent: pin "Windows Ding" (most recognizable system sound).
    private const string PinnedDefault = "Windows Ding";

    private static readonly string MediaFolder =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Media");

    private static readonly HashSet<string> AllowedExtensions =
        [".wav", ".mp3", ".wma"];

    internal static IReadOnlyList<string> SystemOptions
    {
        get
        {
            var names = DiscoverNames();
            names.Remove(PinnedDefault);
            var sorted = names.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
            return [PinnedDefault, .. sorted];
        }
    }

    internal static string DisplayName(string raw) => raw;

    internal static string? Url(string name)
    {
        if (!Directory.Exists(MediaFolder)) return null;
        foreach (var ext in AllowedExtensions)
        {
            var path = Path.Combine(MediaFolder, name + ext);
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private static HashSet<string> DiscoverNames()
    {
        if (!Directory.Exists(MediaFolder))
            return [PinnedDefault];
        try
        {
            return Directory.EnumerateFiles(MediaFolder)
                .Where(f => AllowedExtensions.Contains(
                    Path.GetExtension(f).ToLowerInvariant()))
                .Select(Path.GetFileNameWithoutExtension)
                .OfType<string>()
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
        }
        catch
        {
            return [PinnedDefault];
        }
    }
}
