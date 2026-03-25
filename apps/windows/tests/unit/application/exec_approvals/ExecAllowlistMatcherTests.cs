using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Application.ExecApprovals;

public sealed class ExecAllowlistMatcherTests
{
    // ── Match — null / empty guards ────────────────────────────────────────────

    [Fact]
    public void Match_NullResolution_ReturnsNull()
    {
        ExecAllowlistMatcher.Match(Entries("/usr/bin/git"), resolution: null)
            .Should().BeNull();
    }

    [Fact]
    public void Match_EmptyEntries_ReturnsNull()
    {
        ExecAllowlistMatcher.Match([], Resolution("/usr/bin/git"))
            .Should().BeNull();
    }

    // ── Match — exact path ─────────────────────────────────────────────────────

    [Fact]
    public void Match_ExactAbsolutePath_Matches()
    {
        ExecAllowlistMatcher.Match(Entries("/usr/bin/git"), Resolution("/usr/bin/git"))
            .Should().NotBeNull();
    }

    [Fact]
    public void Match_DifferentAbsolutePath_DoesNotMatch()
    {
        ExecAllowlistMatcher.Match(Entries("/usr/bin/git"), Resolution("/usr/bin/curl"))
            .Should().BeNull();
    }

    // ── Match — glob wildcard semantics ───────────────────────────────────────
    // * matches within a single path component; ** matches across components.

    [Theory]
    // single star — must not cross /
    [InlineData("/usr/bin/*",    "/usr/bin/git",        true)]
    [InlineData("/usr/bin/*",    "/usr/bin/curl",       true)]
    [InlineData("/usr/bin/*",    "/usr/local/bin/git",  false)]
    [InlineData("/usr/bin/*",    "/usr/bins/git",       false)]
    // double star — crosses directory boundaries
    [InlineData("/usr/**",       "/usr/bin/git",        true)]
    [InlineData("/usr/**",       "/usr/local/bin/git",  true)]
    [InlineData("/usr/**",       "/etc/git",            false)]
    public void Match_GlobWildcards_RespectDirectoryBoundarySemantics(
        string pattern, string path, bool shouldMatch)
    {
        var result = ExecAllowlistMatcher.Match(Entries(pattern), Resolution(path));
        if (shouldMatch) result.Should().NotBeNull();
        else             result.Should().BeNull();
    }

    // ── Match — case insensitivity ─────────────────────────────────────────────

    [Fact]
    public void Match_PatternUpperCase_MatchesLowerCasePath()
    {
        // Matching is case-insensitive — critical on Windows where paths are not case-sensitive.
        ExecAllowlistMatcher.Match(Entries("/USR/BIN/GIT"), Resolution("/usr/bin/git"))
            .Should().NotBeNull();
    }

    [Fact]
    public void Match_WindowsBackslashes_NormalizedForMatching()
    {
        // Backslashes are normalized to '/' before comparison.
        ExecAllowlistMatcher.Match(
            Entries(@"C:\tools\git.exe"),
            Resolution(@"C:\tools\git.exe"))
            .Should().NotBeNull();
    }

    [Fact]
    public void Match_WindowsBackslashPattern_MatchesForwardSlashPath()
    {
        ExecAllowlistMatcher.Match(
            Entries(@"C:\tools\*"),
            Resolution(@"C:/tools/git.exe"))
            .Should().NotBeNull();
    }

    // ── Match — invalid patterns silently skipped ─────────────────────────────

    [Fact]
    public void Match_PatternWithoutPathComponent_IsSkipped()
    {
        // "git" has no path separator — fails ValidateAllowlistPattern → must be silently skipped.
        // This prevents a bare executable name from matching any path that ends with that name.
        var entries = new List<ExecAllowlistEntry> { Entry("git") };
        ExecAllowlistMatcher.Match(entries, Resolution("/usr/bin/git"))
            .Should().BeNull("a bare name without a path separator is an invalid allowlist pattern");
    }

    [Fact]
    public void Match_EmptyPattern_IsSkipped()
    {
        var entries = new List<ExecAllowlistEntry> { Entry("") };
        ExecAllowlistMatcher.Match(entries, Resolution("/usr/bin/git"))
            .Should().BeNull();
    }

    [Fact]
    public void Match_WhitespaceOnlyPattern_IsSkipped()
    {
        var entries = new List<ExecAllowlistEntry> { Entry("   ") };
        ExecAllowlistMatcher.Match(entries, Resolution("/usr/bin/git"))
            .Should().BeNull();
    }

    // ── Match — resolved path preferred over raw executable ───────────────────

    [Fact]
    public void Match_UsesResolvedPathWhenAvailable()
    {
        // Pattern targets the full resolved path; the raw token may be just "git".
        var entries = Entries("/usr/bin/git");
        var resolution = new ExecCommandResolution("git", "/usr/bin/git", "git", Cwd: null);
        ExecAllowlistMatcher.Match(entries, resolution)
            .Should().NotBeNull();
    }

    [Fact]
    public void Match_FallsBackToRawExecutableWhenResolvedPathIsNull()
    {
        // When PATH resolution fails, the raw executable token is used for matching.
        var entries = Entries("/usr/bin/git");
        var resolution = new ExecCommandResolution("/usr/bin/git", ResolvedPath: null, "git", Cwd: null);
        ExecAllowlistMatcher.Match(entries, resolution)
            .Should().NotBeNull();
    }

    // ── Match — question mark wildcard ────────────────────────────────────────

    [Fact]
    public void Match_QuestionMark_MatchesSingleCharacter()
    {
        ExecAllowlistMatcher.Match(Entries("/usr/bin/gi?"), Resolution("/usr/bin/git"))
            .Should().NotBeNull();
    }

    [Fact]
    public void Match_QuestionMark_DoesNotMatchZeroCharacters()
    {
        ExecAllowlistMatcher.Match(Entries("/usr/bin/git?"), Resolution("/usr/bin/git"))
            .Should().BeNull();
    }

    // ── Match — returns first matching entry ───────────────────────────────────

    [Fact]
    public void Match_MultipleValidEntries_ReturnsFirstMatch()
    {
        var first  = Entry("/usr/bin/git");
        var second = Entry("/usr/bin/*");
        var entries = new List<ExecAllowlistEntry> { first, second };
        var result = ExecAllowlistMatcher.Match(entries, Resolution("/usr/bin/git"));
        result.Should().Be(first, "the first matching entry is returned");
    }

    // ── MatchAll — all-or-nothing semantics ───────────────────────────────────

    [Fact]
    public void MatchAll_AllResolutionsMatch_ReturnsOneMatchPerResolution()
    {
        var entries    = Entries("/usr/bin/echo", "/usr/bin/grep");
        var resolutions = new[]
        {
            Resolution("/usr/bin/echo"),
            Resolution("/usr/bin/grep"),
        };
        ExecAllowlistMatcher.MatchAll(entries, resolutions).Should().HaveCount(2);
    }

    [Fact]
    public void MatchAll_OneMiss_ReturnsEmpty()
    {
        // A single unmatched resolution rejects the entire chain — prevents an attacker
        // from piping an allowlisted command into an arbitrary one and getting both approved.
        var entries    = Entries("/usr/bin/echo");
        var resolutions = new[]
        {
            Resolution("/usr/bin/echo"),
            Resolution("/usr/bin/rm"),   // not in allowlist
        };
        ExecAllowlistMatcher.MatchAll(entries, resolutions)
            .Should().BeEmpty("a single miss must reject the entire chain (all-or-nothing)");
    }

    [Fact]
    public void MatchAll_EmptyResolutions_ReturnsEmpty()
    {
        ExecAllowlistMatcher.MatchAll(Entries("/usr/bin/git"), []).Should().BeEmpty();
    }

    [Fact]
    public void MatchAll_EmptyEntries_ReturnsEmpty()
    {
        ExecAllowlistMatcher.MatchAll([], [Resolution("/usr/bin/git")]).Should().BeEmpty();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private static List<ExecAllowlistEntry> Entries(params string[] patterns) =>
        [.. patterns.Select(Entry)];

    private static ExecAllowlistEntry Entry(string pattern) =>
        new() { Pattern = pattern };

    private static ExecCommandResolution Resolution(string path) =>
        new(path, path, Path.GetFileName(path), Cwd: null);
}
