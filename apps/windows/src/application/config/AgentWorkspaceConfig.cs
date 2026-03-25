namespace OpenClawWindows.Application.Config;

internal static class AgentWorkspaceConfig
{
    internal static string? Workspace(Dictionary<string, object?> root)
    {
        var agents   = root.GetValueOrDefault("agents")            as Dictionary<string, object?>;
        var defaults = agents?.GetValueOrDefault("defaults")       as Dictionary<string, object?>;
        return defaults?.GetValueOrDefault("workspace") as string;
    }

    internal static void SetWorkspace(Dictionary<string, object?> root, string? workspace)
    {
        var agents   = (root.GetValueOrDefault("agents")   as Dictionary<string, object?>)
                       ?? new Dictionary<string, object?>();
        var defaults = (agents.GetValueOrDefault("defaults") as Dictionary<string, object?>)
                       ?? new Dictionary<string, object?>();

        var trimmed = workspace?.Trim() ?? "";
        if (trimmed.Length == 0)
            defaults.Remove("workspace");
        else
            defaults["workspace"] = trimmed;

        if (defaults.Count == 0)
            agents.Remove("defaults");
        else
            agents["defaults"] = defaults;

        if (agents.Count == 0)
            root.Remove("agents");
        else
            root["agents"] = agents;
    }
}
