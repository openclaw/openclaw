using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Domain.VoiceWake;
using OpenClawWindows.Infrastructure.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Infrastructure.VoiceWake;

public sealed class VoiceWakeChimePlayerTests
{
    private VoiceWakeChimePlayer Make() =>
        new(NullLogger<VoiceWakeChimePlayer>.Instance);

    // --- Play — none/unknown path → early return, no crash ---

    [Fact]
    public void Play_NoneChime_DoesNotThrow()
    {
        // Swift: guard let sound = self.sound(for: .none) else { return } → returns nil → no play
        Make().Play(new VoiceWakeChime.None());
    }

    [Fact]
    public void Play_SystemSoundWithUnknownName_DoesNotThrow()
    {
        // Path resolves to null for an unknown name → early return before logging
        Make().Play(new VoiceWakeChime.SystemSound("__openclaw_nonexistent_sound__"));
    }

    [Fact]
    public void Play_SystemSoundWithUnknownName_WithReason_DoesNotThrow()
    {
        Make().Play(new VoiceWakeChime.SystemSound("__openclaw_nonexistent_sound__"), "wake");
    }

    [Fact]
    public void Play_CustomWithEmptyBookmark_DoesNotThrow()
    {
        // Empty bookmark → DecodeBookmark returns null → early return
        Make().Play(new VoiceWakeChime.Custom("My Sound", []));
    }

    [Fact]
    public void Play_CustomWithInvalidBookmark_DoesNotThrow()
    {
        // Invalid DPAPI bytes → DecodeBookmark catches CryptographicException → null → early return
        Make().Play(new VoiceWakeChime.Custom("My Sound", [0x01, 0x02, 0x03]));
    }

    // --- DecodeBookmark ---

    [Fact]
    public void DecodeBookmark_EmptyArray_ReturnsNull()
    {
        Assert.Null(VoiceWakeChimePlayer.DecodeBookmark([]));
    }

    [Fact]
    public void DecodeBookmark_InvalidDpapiBytes_ReturnsNull()
    {
        // Corrupt DPAPI blob → ProtectedData.Unprotect throws → caught → null
        Assert.Null(VoiceWakeChimePlayer.DecodeBookmark([0xDE, 0xAD, 0xBE, 0xEF]));
    }

    [Fact]
    public void DecodeBookmark_ValidDpapi_NonExistentPath_ReturnsNull()
    {
        // Valid DPAPI blob encoding a path that doesn't exist on disk → null
        var fakePath = Path.Combine(Path.GetTempPath(), "__openclaw_no_such_file__.wav");
        var encrypted = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(fakePath), null, DataProtectionScope.CurrentUser);

        Assert.Null(VoiceWakeChimePlayer.DecodeBookmark(encrypted));
    }

    [Fact]
    public void DecodeBookmark_ValidDpapi_ExistingFile_ReturnsPath()
    {
        // Valid DPAPI blob encoding an existing file path → returns the path
        var tmp = Path.GetTempFileName();
        try
        {
            var encrypted = ProtectedData.Protect(
                Encoding.UTF8.GetBytes(tmp), null, DataProtectionScope.CurrentUser);

            Assert.Equal(tmp, VoiceWakeChimePlayer.DecodeBookmark(encrypted));
        }
        finally
        {
            File.Delete(tmp);
        }
    }
}
