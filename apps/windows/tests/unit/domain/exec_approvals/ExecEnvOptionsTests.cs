using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Domain.ExecApprovals;

public sealed class ExecEnvOptionsTests
{
    // ── WithValue ─────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("-u")]
    [InlineData("--unset")]
    [InlineData("-c")]
    [InlineData("--chdir")]
    [InlineData("-s")]
    [InlineData("--split-string")]
    [InlineData("--default-signal")]
    [InlineData("--ignore-signal")]
    [InlineData("--block-signal")]
    public void WithValue_ContainsExpectedOption(string option) =>
        ExecEnvOptions.WithValue.Should().Contain(option);

    [Fact]
    public void WithValue_HasExactlyNineEntries() =>
        ExecEnvOptions.WithValue.Should().HaveCount(9);

    [Theory]
    [InlineData("-i")]
    [InlineData("--null")]
    [InlineData("FOO=BAR")]
    public void WithValue_DoesNotContainNonValueOptions(string opt) =>
        ExecEnvOptions.WithValue.Should().NotContain(opt);

    // ── FlagOnly ──────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("-i")]
    [InlineData("--ignore-environment")]
    [InlineData("-0")]
    [InlineData("--null")]
    public void FlagOnly_ContainsExpectedFlag(string flag) =>
        ExecEnvOptions.FlagOnly.Should().Contain(flag);

    [Fact]
    public void FlagOnly_HasExactlyFourEntries() =>
        ExecEnvOptions.FlagOnly.Should().HaveCount(4);

    [Theory]
    [InlineData("-u")]
    [InlineData("--unset")]
    public void FlagOnly_DoesNotContainValueOptions(string opt) =>
        ExecEnvOptions.FlagOnly.Should().NotContain(opt);

    // ── InlineValuePrefixes ───────────────────────────────────────────────────

    [Theory]
    [InlineData("-u")]
    [InlineData("-c")]
    [InlineData("-s")]
    [InlineData("--unset=")]
    [InlineData("--chdir=")]
    [InlineData("--split-string=")]
    [InlineData("--default-signal=")]
    [InlineData("--ignore-signal=")]
    [InlineData("--block-signal=")]
    public void InlineValuePrefixes_ContainsExpectedPrefix(string prefix) =>
        ExecEnvOptions.InlineValuePrefixes.Should().Contain(prefix);

    [Fact]
    public void InlineValuePrefixes_HasExactlyNineEntries() =>
        ExecEnvOptions.InlineValuePrefixes.Should().HaveCount(9);

    // ── Disjoint invariants ───────────────────────────────────────────────────

    [Fact]
    public void WithValue_And_FlagOnly_AreDisjoint() =>
        // An option cannot both consume a value and be standalone
        ExecEnvOptions.WithValue.Should().NotIntersectWith(ExecEnvOptions.FlagOnly);
}
