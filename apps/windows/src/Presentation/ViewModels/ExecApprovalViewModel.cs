namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class ExecApprovalViewModel : ObservableObject
{
    public string  CommandText    { get; }
    public string? SessionLabel   { get; }
    public string? AgentLabel     { get; }

    public bool HasSessionLabel => !string.IsNullOrWhiteSpace(SessionLabel);
    public bool HasAgentLabel   => !string.IsNullOrWhiteSpace(AgentLabel);

    public ExecApprovalViewModel(
        string  commandText,
        string? sessionLabel = null,
        string? agentLabel   = null)
    {
        CommandText  = commandText;
        SessionLabel = sessionLabel;
        AgentLabel   = agentLabel;
    }
}
