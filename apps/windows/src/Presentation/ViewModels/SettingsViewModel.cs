using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class SettingsViewModel : ObservableObject
{
    public GeneralSettingsViewModel     General     { get; }
    public ChannelsSettingsViewModel    Channels    { get; }
    public SessionsSettingsViewModel    Sessions    { get; }
    public PermissionsSettingsViewModel Permissions { get; }
    public VoiceWakeSettingsViewModel   VoiceWake   { get; }
    public ConfigSettingsViewModel      Config      { get; }
    public SystemRunSettingsViewModel   SystemRun   { get; }
    public SkillsSettingsViewModel      Skills      { get; }
    public InstancesSettingsViewModel   Instances   { get; }
    public CronSettingsViewModel        Cron        { get; }
    public DebugSettingsViewModel       Debug       { get; }
    public AboutSettingsViewModel       About       { get; }

    [ObservableProperty]
    private bool _debugPaneEnabled;

    public SettingsViewModel(
        GeneralSettingsViewModel general,
        ChannelsSettingsViewModel channels,
        SessionsSettingsViewModel sessions,
        PermissionsSettingsViewModel permissions,
        VoiceWakeSettingsViewModel voiceWake,
        ConfigSettingsViewModel config,
        SystemRunSettingsViewModel systemRun,
        SkillsSettingsViewModel skills,
        InstancesSettingsViewModel instances,
        CronSettingsViewModel cron,
        DebugSettingsViewModel debug,
        AboutSettingsViewModel about)
    {
        General     = general;
        Channels    = channels;
        Sessions    = sessions;
        Permissions = permissions;
        VoiceWake   = voiceWake;
        Config      = config;
        SystemRun   = systemRun;
        Skills      = skills;
        Instances   = instances;
        Cron        = cron;
        Debug       = debug;
        About       = about;
    }
}
