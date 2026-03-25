using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using NAudio.Wave;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.VoiceWake;

namespace OpenClawWindows.Infrastructure.VoiceWake;

// Windows: class for ILogger<T> DI injection; NAudio replaces NSSound/SoundEffectPlayer.
internal sealed class VoiceWakeChimePlayer : IVoiceWakeChimePlayer
{
    private readonly ILogger<VoiceWakeChimePlayer> _logger;

    public VoiceWakeChimePlayer(ILogger<VoiceWakeChimePlayer> logger)
    {
        _logger = logger;
    }

    // Returns immediately; audio is played on a background thread (fire-and-forget).
    public void Play(VoiceWakeChime chime, string? reason = null)
    {
        var path = PathFor(chime);
        if (path is null) return;

        if (reason is not null)
            _logger.LogInformation("chime play reason={Reason}", reason);
        else
            _logger.LogInformation("chime play");

        _logger.LogDebug(
            "chime play chime={Chime} systemName={SystemName} reason={Reason}",
            chime.DisplayLabel, chime.SystemName ?? "", reason ?? "");

        // NSSound is main-actor-safe on macOS; NAudio has no such constraint on Windows.
        _ = Task.Run(() => PlayFile(path));
    }

    private static string? PathFor(VoiceWakeChime chime) => chime switch
    {
        VoiceWakeChime.None => null,
        VoiceWakeChime.SystemSound s => VoiceWakeChimeCatalog.Url(s.Name),
        VoiceWakeChime.Custom(_, var bookmark) => DecodeBookmark(bookmark),
        _ => null,
    };

    internal static string? DecodeBookmark(byte[] bookmark)
    {
        if (bookmark.Length == 0) return null;
        try
        {
            // Windows: bookmark is a DPAPI-encrypted UTF-8 absolute path.
            var pathBytes = ProtectedData.Unprotect(bookmark, null, DataProtectionScope.CurrentUser);
            var path = Encoding.UTF8.GetString(pathBytes);
            return File.Exists(path) ? path : null;
        }
        catch { return null; }
    }

    private static void PlayFile(string path)
    {
        try
        {
            using var reader = new AudioFileReader(path);
            using var output = new WaveOutEvent();
            output.Init(reader);
            output.Play();
            // Spin until playback finishes
            while (output.PlaybackState == PlaybackState.Playing)
                Thread.Sleep(50);
        }
        catch { /* audio failure is non-fatal */ }
    }
}
