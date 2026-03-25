namespace OpenClawWindows.Application.Ports;

/// <summary>
/// Port for enabling/disabling the global push-to-talk hotkey monitor.
/// handlers can toggle PTT without depending on the Infrastructure WH_KEYBOARD_LL hook.
/// </summary>
internal interface IVoicePushToTalkService
{
    void SetEnabled(bool enabled);
}
