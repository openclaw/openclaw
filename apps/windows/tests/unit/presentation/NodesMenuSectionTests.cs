using OpenClawWindows.Domain.Nodes;
using OpenClawWindows.Presentation.Tray;
using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class NodesMenuSectionTests
{
    // ── Constants ─────────────────────────────────────────────────────────────

    [Fact]
    public void MaxVisibleNodes_MatchesSwift()
    {
        Assert.Equal(8, NodesMenuSection.MaxVisibleNodes);
    }

    // ── NodeMenuRowView constants ─────────────────────────────────────────────

    [Fact]
    public void RowPaddingVertical_MatchesSwift()  => Assert.Equal(8.0,  NodeMenuRowView.PaddingVertical);
    [Fact]
    public void RowPaddingLeading_MatchesSwift()   => Assert.Equal(18.0, NodeMenuRowView.PaddingLeading);
    [Fact]
    public void RowPaddingTrailing_MatchesSwift()  => Assert.Equal(12.0, NodeMenuRowView.PaddingTrailing);
    [Fact]
    public void RowIconSize_MatchesSwift()         => Assert.Equal(22.0, NodeMenuRowView.IconSize);

    // ── NodeMenuEntryFormatter — IsGateway ───────────────────────────────────

    [Fact]
    public void IsGateway_WhenNodeIdIsGateway_ReturnsTrue()
    {
        Assert.True(NodeMenuEntryFormatter.IsGateway(Node("gateway")));
    }

    [Fact]
    public void IsGateway_WhenNodeIdIsOther_ReturnsFalse()
    {
        Assert.False(NodeMenuEntryFormatter.IsGateway(Node("alice")));
    }

    // ── PrimaryName ───────────────────────────────────────────────────────────

    [Fact]
    public void PrimaryName_Gateway_NoDisplayName_ReturnsGateway()
    {
        Assert.Equal("Gateway", NodeMenuEntryFormatter.PrimaryName(Node("gateway")));
    }

    [Fact]
    public void PrimaryName_Gateway_WithDisplayName_ReturnsDisplayName()
    {
        Assert.Equal("My Gateway", NodeMenuEntryFormatter.PrimaryName(
            Node("gateway", displayName: "My Gateway")));
    }

    [Fact]
    public void PrimaryName_NonGateway_NoDisplayName_ReturnsNodeId()
    {
        Assert.Equal("alice", NodeMenuEntryFormatter.PrimaryName(Node("alice")));
    }

    [Fact]
    public void PrimaryName_NonGateway_WithDisplayName_ReturnsDisplayName()
    {
        Assert.Equal("Alice's Mac", NodeMenuEntryFormatter.PrimaryName(
            Node("alice", displayName: "Alice's Mac")));
    }

    // ── RoleText ──────────────────────────────────────────────────────────────

    [Fact]
    public void RoleText_Connected_ReturnsConnected()
    {
        Assert.Equal("connected", NodeMenuEntryFormatter.RoleText(
            Node("x", connected: true)));
    }

    [Fact]
    public void RoleText_Gateway_Disconnected_ReturnsDisconnected()
    {
        Assert.Equal("disconnected", NodeMenuEntryFormatter.RoleText(Node("gateway")));
    }

    [Fact]
    public void RoleText_Paired_NotConnected_ReturnsPaired()
    {
        Assert.Equal("paired", NodeMenuEntryFormatter.RoleText(
            Node("x", paired: true)));
    }

    [Fact]
    public void RoleText_Unpaired_NotConnected_ReturnsUnpaired()
    {
        Assert.Equal("unpaired", NodeMenuEntryFormatter.RoleText(Node("x")));
    }

    // ── DetailLeft ────────────────────────────────────────────────────────────

    [Fact]
    public void DetailLeft_WithIp_ReturnsIpAndRole()
    {
        var entry = Node("x", connected: true, remoteIp: "192.168.1.1");
        Assert.Equal("192.168.1.1 · connected", NodeMenuEntryFormatter.DetailLeft(entry));
    }

    [Fact]
    public void DetailLeft_NoIp_ReturnsRoleOnly()
    {
        Assert.Equal("unpaired", NodeMenuEntryFormatter.DetailLeft(Node("x")));
    }

    // ── PlatformText ──────────────────────────────────────────────────────────

    [Fact]
    public void PlatformText_Darwin_ReturnsDarwin()
    {
        // PlatformLabelFormatter.Pretty("darwin") → "Darwin"
        var result = NodeMenuEntryFormatter.PlatformText(Node("x", platform: "darwin"));
        Assert.NotNull(result);
    }

    [Fact]
    public void PlatformText_DeviceFamilyMac_ReturnsMacOS()
    {
        var result = NodeMenuEntryFormatter.PlatformText(Node("x", deviceFamily: "Mac"));
        Assert.Equal("macOS", result);
    }

    [Fact]
    public void PlatformText_DeviceFamilyIPhone_ReturnsIOS()
    {
        var result = NodeMenuEntryFormatter.PlatformText(Node("x", deviceFamily: "iPhone"));
        Assert.Equal("iOS", result);
    }

    [Fact]
    public void PlatformText_DeviceFamilyIPad_ReturnsIPadOS()
    {
        var result = NodeMenuEntryFormatter.PlatformText(Node("x", deviceFamily: "iPad"));
        Assert.Equal("iPadOS", result);
    }

    [Fact]
    public void PlatformText_DeviceFamilyAndroid_ReturnsAndroid()
    {
        var result = NodeMenuEntryFormatter.PlatformText(Node("x", deviceFamily: "android"));
        Assert.Equal("Android", result);
    }

    // ── IsAndroid ─────────────────────────────────────────────────────────────

    [Fact]
    public void IsAndroid_DeviceFamilyAndroid_ReturnsTrue()
    {
        Assert.True(NodeMenuEntryFormatter.IsAndroid(Node("x", deviceFamily: "android")));
    }

    [Fact]
    public void IsAndroid_PlatformContainsAndroid_ReturnsTrue()
    {
        Assert.True(NodeMenuEntryFormatter.IsAndroid(Node("x", platform: "android arm64")));
    }

    [Fact]
    public void IsAndroid_Neither_ReturnsFalse()
    {
        Assert.False(NodeMenuEntryFormatter.IsAndroid(Node("x", platform: "darwin")));
    }

    // ── IsHeadlessPlatform → resolveVersions ─────────────────────────────────

    [Fact]
    public void DetailRightVersion_CoreAndUi_BothLabelled()
    {
        var entry = Node("x", coreVersion: "1.2.3", uiVersion: "4.5.6");
        var result = NodeMenuEntryFormatter.DetailRightVersion(entry);
        Assert.NotNull(result);
        Assert.Contains("core", result);
        Assert.Contains("ui",   result);
    }

    [Fact]
    public void DetailRightVersion_LegacyDarwin_CoreOnly()
    {
        // darwin is headless → legacy goes to core, ui=null
        var entry = Node("x", platform: "darwin", version: "2.0");
        var result = NodeMenuEntryFormatter.DetailRightVersion(entry);
        Assert.NotNull(result);
        Assert.Contains("core", result!);
        Assert.DoesNotContain("ui", result!);
    }

    [Fact]
    public void DetailRightVersion_LegacyNonHeadless_UiOnly()
    {
        // non-headless → legacy goes to ui
        var entry = Node("x", platform: "iOS", version: "2.0");
        var result = NodeMenuEntryFormatter.DetailRightVersion(entry);
        Assert.NotNull(result);
        Assert.Contains("ui", result!);
        Assert.DoesNotContain("core", result!);
    }

    // ── CompactVersion (via LeadingGlyph as proxy — just verify gateway glyph) ──

    [Fact]
    public void LeadingGlyph_Gateway_IsNetworkTowerGlyph()
    {
        Assert.Equal("\uE704", NodeMenuEntryFormatter.LeadingGlyph(Node("gateway")));
    }

    [Fact]
    public void LeadingGlyph_Unknown_IsCpuGlyph()
    {
        Assert.Equal("\uE7EF", NodeMenuEntryFormatter.LeadingGlyph(Node("x")));
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static NodeInfo Node(
        string nodeId,
        string? displayName  = null,
        string? platform     = null,
        string? version      = null,
        string? coreVersion  = null,
        string? uiVersion    = null,
        string? deviceFamily = null,
        string? remoteIp     = null,
        bool connected       = false,
        bool paired          = false) =>
        new(NodeId:          nodeId,
            DisplayName:     displayName,
            Platform:        platform,
            Version:         version,
            CoreVersion:     coreVersion,
            UiVersion:       uiVersion,
            DeviceFamily:    deviceFamily,
            ModelIdentifier: null,
            RemoteIp:        remoteIp,
            Caps:            null,
            Commands:        null,
            Permissions:     null,
            Paired:          paired,
            Connected:       connected);
}
