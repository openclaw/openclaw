using OpenClawWindows.Application.Config;

namespace OpenClawWindows.Tests.Unit.Application.Config;

public sealed class AgentWorkspaceConfigTests
{
    // ── Workspace (read) ──────────────────────────────────────────────────────

    [Fact]
    public void Workspace_WhenPathSet_ReturnsValue()
    {
        var root = new Dictionary<string, object?>
        {
            ["agents"] = new Dictionary<string, object?>
            {
                ["defaults"] = new Dictionary<string, object?> { ["workspace"] = "/home/user/ws" },
            },
        };

        Assert.Equal("/home/user/ws", AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void Workspace_WhenAgentsMissing_ReturnsNull()
    {
        var root = new Dictionary<string, object?>();
        Assert.Null(AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void Workspace_WhenDefaultsMissing_ReturnsNull()
    {
        var root = new Dictionary<string, object?>
        {
            ["agents"] = new Dictionary<string, object?>(),
        };

        Assert.Null(AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void Workspace_WhenWorkspaceKeyMissing_ReturnsNull()
    {
        var root = new Dictionary<string, object?>
        {
            ["agents"] = new Dictionary<string, object?>
            {
                ["defaults"] = new Dictionary<string, object?>(),
            },
        };

        Assert.Null(AgentWorkspaceConfig.Workspace(root));
    }

    // ── SetWorkspace (write) ──────────────────────────────────────────────────

    [Fact]
    public void SetWorkspace_NonEmpty_StoresInRoot()
    {
        var root = new Dictionary<string, object?>();

        AgentWorkspaceConfig.SetWorkspace(root, "/my/workspace");

        Assert.Equal("/my/workspace", AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void SetWorkspace_TrimsWhitespace()
    {
        // mirrors Swift: workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        var root = new Dictionary<string, object?>();

        AgentWorkspaceConfig.SetWorkspace(root, "  /my/workspace  ");

        Assert.Equal("/my/workspace", AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void SetWorkspace_Null_RemovesWorkspaceKey()
    {
        // mirrors Swift: trimmed.isEmpty → defaults.removeValue(forKey: "workspace")
        var root = new Dictionary<string, object?>
        {
            ["agents"] = new Dictionary<string, object?>
            {
                ["defaults"] = new Dictionary<string, object?> { ["workspace"] = "/old" },
            },
        };

        AgentWorkspaceConfig.SetWorkspace(root, null);

        Assert.Null(AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void SetWorkspace_EmptyString_RemovesWorkspaceKey()
    {
        var root = new Dictionary<string, object?>();
        AgentWorkspaceConfig.SetWorkspace(root, "/ws");
        AgentWorkspaceConfig.SetWorkspace(root, "");

        Assert.Null(AgentWorkspaceConfig.Workspace(root));
    }

    [Fact]
    public void SetWorkspace_NullOnEmptyRoot_LeavesRootEmpty()
    {
        // mirrors Swift: if agents.isEmpty { root.removeValue(forKey: "agents") }
        var root = new Dictionary<string, object?>();

        AgentWorkspaceConfig.SetWorkspace(root, null);

        Assert.Empty(root);
    }

    [Fact]
    public void SetWorkspace_ClearingValue_RemovesEmptyIntermediaries()
    {
        // Removing the only defaults key cascades: defaults → empty → remove from agents,
        // agents → empty → remove from root. Mirrors Swift collapse logic.
        var root = new Dictionary<string, object?>();
        AgentWorkspaceConfig.SetWorkspace(root, "/ws");
        AgentWorkspaceConfig.SetWorkspace(root, null);

        Assert.False(root.ContainsKey("agents"));
    }

    [Fact]
    public void SetWorkspace_PreservesOtherKeysInRoot()
    {
        // Other root keys must not be touched
        var root = new Dictionary<string, object?> { ["other"] = "value" };

        AgentWorkspaceConfig.SetWorkspace(root, "/ws");

        Assert.Equal("value", root["other"] as string);
    }

    [Fact]
    public void SetWorkspace_PreservesOtherKeysInAgents()
    {
        // Other agents keys must survive a workspace update
        var root = new Dictionary<string, object?>
        {
            ["agents"] = new Dictionary<string, object?>
            {
                ["defaults"] = new Dictionary<string, object?> { ["workspace"] = "/old" },
                ["extra"]    = "kept",
            },
        };

        AgentWorkspaceConfig.SetWorkspace(root, "/new");

        var agents = root["agents"] as Dictionary<string, object?>;
        Assert.Equal("kept", agents!["extra"] as string);
    }

    [Fact]
    public void RoundTrip_WriteAndRead_Consistent()
    {
        var root = new Dictionary<string, object?>();
        AgentWorkspaceConfig.SetWorkspace(root, "/round/trip");
        Assert.Equal("/round/trip", AgentWorkspaceConfig.Workspace(root));
    }
}
