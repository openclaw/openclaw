using OpenClawWindows.Presentation.Tray.Components;
using Windows.UI;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SessionMenuPreviewViewTests
{
    // ── Layout constants — mirrors SessionMenuPreviewView.swift ───────────────

    [Fact] public void PaddingVertical_MatchesSwift()  => Assert.Equal(6.0,  SessionMenuPreviewView.PaddingVertical);
    [Fact] public void PaddingLeading_MatchesSwift()   => Assert.Equal(16.0, SessionMenuPreviewView.PaddingLeading);
    [Fact] public void PaddingTrailing_MatchesSwift()  => Assert.Equal(11.0, SessionMenuPreviewView.PaddingTrailing);
    [Fact] public void Spacing_MatchesSwift()          => Assert.Equal(8.0,  SessionMenuPreviewView.Spacing);
    [Fact] public void ItemSpacing_MatchesSwift()      => Assert.Equal(6.0,  SessionMenuPreviewView.ItemSpacing);
    [Fact] public void RoleLabelWidth_MatchesSwift()   => Assert.Equal(50.0, SessionMenuPreviewView.RoleLabelWidth);
    [Fact] public void RoleSpacing_MatchesSwift()      => Assert.Equal(4.0,  SessionMenuPreviewView.RoleSpacing);

    // ── PreviewRole.Label — mirrors PreviewRole.label computed var ─────────────

    [Theory]
    [InlineData(PreviewRole.User,      "User")]
    [InlineData(PreviewRole.Assistant, "Agent")]
    [InlineData(PreviewRole.Tool,      "Tool")]
    [InlineData(PreviewRole.System,    "System")]
    [InlineData(PreviewRole.Other,     "Other")]
    internal void RoleLabel_MatchesSwift(PreviewRole role, string expected)
    {
        Assert.Equal(expected, role.Label());
    }

    // ── RoleColor — highlighted overrides all roles to white @ 90% ────────────

    [Theory]
    [InlineData(PreviewRole.User)]
    [InlineData(PreviewRole.Assistant)]
    [InlineData(PreviewRole.Tool)]
    [InlineData(PreviewRole.System)]
    [InlineData(PreviewRole.Other)]
    internal void RoleColor_Highlighted_IsWhiteAt90Percent(PreviewRole role)
    {
        var color = SessionMenuPreviewView.RoleColor(role, highlighted: true);
        Assert.Equal(0xE5, color.A); // 0.9 × 255 ≈ 229 = 0xE5
        Assert.Equal(0xFF, color.R);
        Assert.Equal(0xFF, color.G);
        Assert.Equal(0xFF, color.B);
    }

    [Fact]
    public void RoleColor_Tool_NotHighlighted_IsOrange()
    {
        var color = SessionMenuPreviewView.RoleColor(PreviewRole.Tool, highlighted: false);
        Assert.Equal(0xFF, color.A);
        Assert.Equal(0xFF, color.R);  // orange R
    }

    [Fact]
    public void RoleColor_User_NotHighlighted_IsOpaque()
    {
        var color = SessionMenuPreviewView.RoleColor(PreviewRole.User, highlighted: false);
        Assert.Equal(0xFF, color.A); // user = accent = fully opaque
    }

    [Fact]
    public void RoleColor_Assistant_NotHighlighted_IsTranslucent()
    {
        var color = SessionMenuPreviewView.RoleColor(PreviewRole.Assistant, highlighted: false);
        Assert.Equal(0x99, color.A); // .secondary ≈ 60% opacity
    }
}
