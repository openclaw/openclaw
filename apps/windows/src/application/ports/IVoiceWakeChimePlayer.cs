using OpenClawWindows.Domain.VoiceWake;

namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Port for playing voice-wake audio cues.
/// to a DI-injectable interface so Presentation can trigger chimes without depending on Infrastructure.
/// </summary>
internal interface IVoiceWakeChimePlayer
{
    void Play(VoiceWakeChime chime, string? reason = null);
}
