namespace OpenClawWindows.Tests.Unit.Domain.ExecApprovals;

public sealed class ExecApprovalHelpersTests
{
    // ── ValidateAllowlistPattern ───────────────────────────────────────────────

    [Fact]
    public void ValidateAllowlistPattern_Null_ReturnsInvalid_Empty()
    {
        var result = ExecApprovalHelpers.ValidateAllowlistPattern(null);
        result.Should().BeOfType<ExecAllowlistPatternValidation.Invalid>()
            .Which.Reason.Should().Be(ExecAllowlistPatternValidationReason.Empty);
    }

    [Fact]
    public void ValidateAllowlistPattern_EmptyString_ReturnsInvalid_Empty()
    {
        var result = ExecApprovalHelpers.ValidateAllowlistPattern("   ");
        result.Should().BeOfType<ExecAllowlistPatternValidation.Invalid>()
            .Which.Reason.Should().Be(ExecAllowlistPatternValidationReason.Empty);
    }

    [Fact]
    public void ValidateAllowlistPattern_NoPathComponent_ReturnsInvalid_MissingPath()
    {
        var result = ExecApprovalHelpers.ValidateAllowlistPattern("ls");
        result.Should().BeOfType<ExecAllowlistPatternValidation.Invalid>()
            .Which.Reason.Should().Be(ExecAllowlistPatternValidationReason.MissingPathComponent);
    }

    [Theory]
    [InlineData("/usr/bin/ls")]
    [InlineData("~/scripts/run.sh")]
    [InlineData(@"C:\tools\run.exe")]
    [InlineData("./relative/path")]
    public void ValidateAllowlistPattern_WithPathComponent_ReturnsValid(string pattern)
    {
        var result = ExecApprovalHelpers.ValidateAllowlistPattern(pattern);
        result.Should().BeOfType<ExecAllowlistPatternValidation.Valid>()
            .Which.Pattern.Should().Be(pattern);
    }

    [Fact]
    public void ValidateAllowlistPattern_TrimsWhitespace()
    {
        var result = ExecApprovalHelpers.ValidateAllowlistPattern("  /usr/bin/ls  ");
        result.Should().BeOfType<ExecAllowlistPatternValidation.Valid>()
            .Which.Pattern.Should().Be("/usr/bin/ls");
    }

    // ── IsPathPattern ─────────────────────────────────────────────────────────

    [Fact]
    public void IsPathPattern_ValidPath_ReturnsTrue()
    {
        ExecApprovalHelpers.IsPathPattern("/usr/bin/node").Should().BeTrue();
    }

    [Fact]
    public void IsPathPattern_NoPath_ReturnsFalse()
    {
        ExecApprovalHelpers.IsPathPattern("node").Should().BeFalse();
    }

    // ── RequiresAsk ───────────────────────────────────────────────────────────

    [Fact]
    public void RequiresAsk_AskAlways_ReturnsTrue()
    {
        // Always ask regardless of security mode or match
        ExecApprovalHelpers.RequiresAsk(ExecAsk.Always, ExecSecurity.Full, null, false).Should().BeTrue();
        ExecApprovalHelpers.RequiresAsk(ExecAsk.Always, ExecSecurity.Allowlist, new ExecAllowlistEntry { Pattern = "/usr/bin/node" }, false).Should().BeTrue();
        ExecApprovalHelpers.RequiresAsk(ExecAsk.Always, ExecSecurity.Full, null, skillAllow: true).Should().BeTrue();
    }

    [Fact]
    public void RequiresAsk_AskOff_ReturnsFalse()
    {
        ExecApprovalHelpers.RequiresAsk(ExecAsk.Off, ExecSecurity.Allowlist, null, false).Should().BeFalse();
    }

    [Fact]
    public void RequiresAsk_OnMiss_Allowlist_NoMatch_NoSkill_ReturnsTrue()
    {
        // Miss on allowlist with no skill approval → must ask
        ExecApprovalHelpers.RequiresAsk(ExecAsk.OnMiss, ExecSecurity.Allowlist, null, skillAllow: false).Should().BeTrue();
    }

    [Fact]
    public void RequiresAsk_OnMiss_Allowlist_WithMatch_ReturnsFalse()
    {
        // Hit on allowlist → no need to ask
        ExecApprovalHelpers.RequiresAsk(ExecAsk.OnMiss, ExecSecurity.Allowlist, new ExecAllowlistEntry { Pattern = "/usr/bin/node" }, skillAllow: false).Should().BeFalse();
    }

    [Fact]
    public void RequiresAsk_OnMiss_Allowlist_SkillAllow_ReturnsFalse()
    {
        // Skill binary auto-approved → no need to ask
        ExecApprovalHelpers.RequiresAsk(ExecAsk.OnMiss, ExecSecurity.Allowlist, null, skillAllow: true).Should().BeFalse();
    }

    [Fact]
    public void RequiresAsk_OnMiss_FullSecurity_ReturnsFalse()
    {
        // Full security allows all → OnMiss condition doesn't trigger
        ExecApprovalHelpers.RequiresAsk(ExecAsk.OnMiss, ExecSecurity.Full, null, false).Should().BeFalse();
    }
}
