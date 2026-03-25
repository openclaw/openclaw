namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class PairingApprovalViewModel : ObservableObject
{
    public string   DeviceDisplayName { get; }
    public string?  Platform          { get; }
    public string?  Role              { get; }
    public string?  ScopesDisplay     { get; }
    public string?  RemoteIp          { get; }
    public bool     IsRepair          { get; }

    public bool HasPlatform  => !string.IsNullOrWhiteSpace(Platform);
    public bool HasRole      => !string.IsNullOrWhiteSpace(Role);
    public bool HasScopes    => !string.IsNullOrWhiteSpace(ScopesDisplay);
    public bool HasRemoteIp  => !string.IsNullOrWhiteSpace(RemoteIp);

    public PairingApprovalViewModel(
        string deviceDisplayName,
        string? platform,
        string? role,
        IEnumerable<string>? scopes,
        string? remoteIp,
        bool isRepair)
    {
        DeviceDisplayName = deviceDisplayName;
        Platform          = platform;
        Role              = role;
        ScopesDisplay     = scopes is not null ? string.Join(", ", scopes) : null;
        RemoteIp          = remoteIp;
        IsRepair          = isRepair;
    }
}
