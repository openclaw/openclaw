using System.Media;
using System.Security.Cryptography;
using System.Text;

namespace OpenClawWindows.Infrastructure.Lifecycle;

// macOS search roots (~/Library/Sounds, /System/Library/Sounds) adapt to C:\Windows\Media.
// fallbackNames are macOS-specific (Glass, Ping, Pop…) and have no Windows equivalents.
internal static class SoundEffectCatalog
{
    // Tunables
    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
        { "aif", "aiff", "caf", "wav", "m4a", "mp3" };

    private static readonly string[] SearchRoots =
    [
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Media"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Sounds"),
    ];

    private static readonly Lazy<IReadOnlyDictionary<string, string>> DiscoveredSoundMap =
        new(BuildSoundMap, LazyThreadSafetyMode.ExecutionAndPublication);

    // macOS pins "Glass" first; Windows has no fixed default so the list is fully sorted.
    internal static IReadOnlyList<string> SystemOptions
    {
        get
        {
            var names = DiscoveredSoundMap.Value.Keys.ToList();
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names;
        }
    }

    internal static string DisplayName(string raw) => raw;

    internal static string? GetFilePath(string name) =>
        DiscoveredSoundMap.Value.TryGetValue(name, out var path) ? path : null;

    private static Dictionary<string, string> BuildSoundMap()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var root in SearchRoots)
        {
            if (!Directory.Exists(root)) continue;
            try
            {
                foreach (var file in Directory.GetFiles(root, "*.*", SearchOption.TopDirectoryOnly))
                {
                    var ext = System.IO.Path.GetExtension(file).TrimStart('.').ToLowerInvariant();
                    if (!AllowedExtensions.Contains(ext)) continue;
                    var name = System.IO.Path.GetFileNameWithoutExtension(file);
                    // Preserve the first match in priority order — same as Swift.
                    if (!map.ContainsKey(name))
                        map[name] = file;
                }
            }
            catch { /* skip inaccessible directories */ }
        }
        return map;
    }
}

// NSSound adapts to System.Media.SoundPlayer (WAV-only; non-WAV paths return null).
// Security-scoped bookmarks (macOS) adapt to DPAPI-encrypted paths (Windows),
// matching the pattern established in VoiceWakeChimePlayer.
internal static class SoundEffectPlayer
{
    private static SoundPlayer? _lastPlayer;
    private static readonly object _lock = new();

    internal static SoundPlayer? Sound(string name)
    {
        var path = SoundEffectCatalog.GetFilePath(name);
        if (path is null) return null;
        if (!path.EndsWith(".wav", StringComparison.OrdinalIgnoreCase)) return null;
        try { return new SoundPlayer(path); }
        catch { return null; }
    }

    internal static SoundPlayer? Sound(byte[] bookmark)
    {
        var path = DecodeBookmark(bookmark);
        if (path is null) return null;
        if (!path.EndsWith(".wav", StringComparison.OrdinalIgnoreCase)) return null;
        try { return new SoundPlayer(path); }
        catch { return null; }
    }

    internal static void Play(SoundPlayer? player)
    {
        if (player is null) return;
        SoundPlayer? previous;
        lock (_lock)
        {
            previous = _lastPlayer;
            _lastPlayer = player;
        }
        previous?.Stop();
        player.Play(); // asynchronous — returns immediately like NSSound.play()
    }

    // Windows: bookmark is a DPAPI-encrypted UTF-8 absolute path.
    internal static string? DecodeBookmark(byte[] bookmark)
    {
        if (bookmark.Length == 0) return null;
        try
        {
            var pathBytes = ProtectedData.Unprotect(bookmark, null, DataProtectionScope.CurrentUser);
            var path = Encoding.UTF8.GetString(pathBytes);
            return File.Exists(path) ? path : null;
        }
        catch { return null; }
    }
}
