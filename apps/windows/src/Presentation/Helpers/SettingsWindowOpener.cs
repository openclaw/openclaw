namespace OpenClawWindows.Presentation.Helpers;

/// <summary>Opens and focuses the Settings window via a registered callback action.</summary>
internal sealed class SettingsWindowOpener
{
    public static readonly SettingsWindowOpener Shared = new();

    private Action? _openSettingsAction;

    public void Register(Action openSettings)
    {
        _openSettingsAction = openSettings;
    }

    public void Open()
    {
        // window activation is handled by the registered action.
        if (_openSettingsAction is not null)
        {
            _openSettingsAction();
            return;
        }

        // has no Windows equivalent; no-op if Register() was not called.
    }
}
