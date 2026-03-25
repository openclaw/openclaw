using OpenClawWindows.Infrastructure.Lifecycle;
using DataProtScope = global::System.Security.Cryptography.DataProtectionScope;
using ProtectedData = global::System.Security.Cryptography.ProtectedData;
using Utf8          = global::System.Text.Encoding;

namespace OpenClawWindows.Tests.Unit.Infrastructure.System;

public sealed class SoundEffectsTests
{
    // ── SoundEffectCatalog ────────────────────────────────────────────────────

    [Fact]
    public void DisplayName_ReturnsRawUnchanged()
    {
        // Swift: static func displayName(for raw: String) -> String { raw }
        Assert.Equal("Glass", SoundEffectCatalog.DisplayName("Glass"));
        Assert.Equal("", SoundEffectCatalog.DisplayName(""));
    }

    [Fact]
    public void SystemOptions_IsSortedCaseInsensitive()
    {
        // Swift: names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        var options = SoundEffectCatalog.SystemOptions;
        var sorted  = options.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
        Assert.Equal(sorted, options);
    }

    [Fact]
    public void SystemOptions_ReturnsOnlyAllowedExtensions()
    {
        // All items in SystemOptions must correspond to allowed-extension files.
        // Verify indirectly: GetFilePath for each name returns a path with an allowed extension.
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            { "aif", "aiff", "caf", "wav", "m4a", "mp3" };
        foreach (var name in SoundEffectCatalog.SystemOptions)
        {
            var path = SoundEffectCatalog.GetFilePath(name);
            Assert.NotNull(path);
            var ext = Path.GetExtension(path!).TrimStart('.');
            Assert.Contains(ext, allowed);
        }
    }

    [Fact]
    public void GetFilePath_UnknownName_ReturnsNull()
    {
        // Swift: discoveredSoundMap[name] — nil when not found
        Assert.Null(SoundEffectCatalog.GetFilePath("__no_such_openclaw_sound__"));
    }

    [Fact]
    public void GetFilePath_KnownName_ReturnsExistingFile()
    {
        // Only runs if Windows Media sounds are present (CI may skip silently).
        var firstName = SoundEffectCatalog.SystemOptions.FirstOrDefault();
        if (firstName is null) return; // no sounds installed — skip

        var path = SoundEffectCatalog.GetFilePath(firstName);
        Assert.NotNull(path);
        Assert.True(File.Exists(path));
    }

    // ── SoundEffectPlayer ─────────────────────────────────────────────────────

    [Fact]
    public void Sound_UnknownName_ReturnsNull()
    {
        // Swift: sound(named:) → NSSound(named:) → nil; url(for:) → nil → nil
        Assert.Null(SoundEffectPlayer.Sound("__no_such_sound__"));
    }

    [Fact]
    public void Sound_EmptyBookmark_ReturnsNull()
    {
        // Swift: guard let url = try? URL(resolvingBookmarkData:…) else { return nil }
        Assert.Null(SoundEffectPlayer.Sound([]));
    }

    [Fact]
    public void Sound_InvalidBookmarkBytes_ReturnsNull()
    {
        // DPAPI unprotect on garbage bytes throws CryptographicException → null
        Assert.Null(SoundEffectPlayer.Sound([0xDE, 0xAD, 0xBE, 0xEF]));
    }

    [Fact]
    public void Play_Null_DoesNotThrow()
    {
        // Swift: guard let sound else { return }
        SoundEffectPlayer.Play(null); // must not throw
    }

    // ── DecodeBookmark ────────────────────────────────────────────────────────

    [Fact]
    public void DecodeBookmark_EmptyArray_ReturnsNull()
    {
        Assert.Null(SoundEffectPlayer.DecodeBookmark([]));
    }

    [Fact]
    public void DecodeBookmark_InvalidDpapi_ReturnsNull()
    {
        Assert.Null(SoundEffectPlayer.DecodeBookmark([0x01, 0x02, 0x03]));
    }

    [Fact]
    public void DecodeBookmark_NonExistentPath_ReturnsNull()
    {
        var fakePath = Path.Combine(Path.GetTempPath(), "__openclaw_no_sound__.wav");
        var encrypted = ProtectedData.Protect(
            Utf8.UTF8.GetBytes(fakePath),
            null,
            DataProtScope.CurrentUser);

        Assert.Null(SoundEffectPlayer.DecodeBookmark(encrypted));
    }

    [Fact]
    public void DecodeBookmark_ValidPath_ReturnsPath()
    {
        var tmp = Path.GetTempFileName();
        try
        {
            var encrypted = ProtectedData.Protect(
                Utf8.UTF8.GetBytes(tmp),
                null,
                DataProtScope.CurrentUser);

            Assert.Equal(tmp, SoundEffectPlayer.DecodeBookmark(encrypted));
        }
        finally
        {
            File.Delete(tmp);
        }
    }
}
