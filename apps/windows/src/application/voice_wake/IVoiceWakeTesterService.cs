namespace OpenClawWindows.Application.VoiceWake;

/// <summary>
/// Port for voice wake recognition test lifecycle, driven by VoiceWakeSettingsPage.
/// </summary>
internal interface IVoiceWakeTesterService
{
    Task StartAsync(
        IEnumerable<string>         triggers,
        string?                     micID,
        string?                     localeID,
        Action<VoiceWakeTestState>  onUpdate,
        CancellationToken           ct = default);

    void Stop();

    void Finalize(TimeSpan timeout = default);
}
