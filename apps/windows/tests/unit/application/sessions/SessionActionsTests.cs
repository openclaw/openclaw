using OpenClawWindows.Application.Sessions;

namespace OpenClawWindows.Tests.Unit.Application.Sessions;

public sealed class SessionActionsTests
{
    private readonly IGatewayRpcChannel _channel = Substitute.For<IGatewayRpcChannel>();

    // ── PatchAsync ────────────────────────────────────────────────────────────

    [Fact]
    public async Task PatchAsync_KeyOnly_SendsKeyWithNoOptionalFields()
    {
        await SessionActions.PatchAsync(_channel, "main");

        await _channel.Received(1).RequestRawAsync(
            "sessions.patch",
            Arg.Is<Dictionary<string, object?>>(d =>
                d.ContainsKey("key") && (string?)d["key"] == "main" &&
                !d.ContainsKey("thinkingLevel") &&
                !d.ContainsKey("verboseLevel")),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PatchAsync_ThinkingSet_IncludesThinkingLevel()
    {
        await SessionActions.PatchAsync(_channel, "main",
            thinking: SessionActions.NullableField.Of("auto"));

        await _channel.Received(1).RequestRawAsync(
            "sessions.patch",
            Arg.Is<Dictionary<string, object?>>(d =>
                (string?)d["thinkingLevel"] == "auto"),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PatchAsync_ThinkingExplicitNull_SendsNullThinkingLevel()
    {
        // Double-optional inner null: clears the field server-side
        await SessionActions.PatchAsync(_channel, "main",
            thinking: SessionActions.NullableField.Clear);

        await _channel.Received(1).RequestRawAsync(
            "sessions.patch",
            Arg.Is<Dictionary<string, object?>>(d =>
                d.ContainsKey("thinkingLevel") && d["thinkingLevel"] == null),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PatchAsync_BothFields_IncludesBothInParams()
    {
        await SessionActions.PatchAsync(_channel, "main",
            thinking: SessionActions.NullableField.Of("high"),
            verbose: SessionActions.NullableField.Of("verbose"));

        await _channel.Received(1).RequestRawAsync(
            "sessions.patch",
            Arg.Is<Dictionary<string, object?>>(d =>
                (string?)d["thinkingLevel"] == "high" &&
                (string?)d["verboseLevel"] == "verbose"),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    // ── ResetAsync ────────────────────────────────────────────────────────────

    [Fact]
    public async Task ResetAsync_SendsCorrectMethodAndKey()
    {
        await SessionActions.ResetAsync(_channel, "session-xyz");

        await _channel.Received(1).RequestRawAsync(
            "sessions.reset",
            Arg.Is<Dictionary<string, object?>>(d =>
                (string?)d["key"] == "session-xyz" && d.Count == 1),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    // ── DeleteAsync ───────────────────────────────────────────────────────────

    [Fact]
    public async Task DeleteAsync_AlwaysIncludesDeleteTranscriptTrue()
    {
        await SessionActions.DeleteAsync(_channel, "session-abc");

        await _channel.Received(1).RequestRawAsync(
            "sessions.delete",
            Arg.Is<Dictionary<string, object?>>(d =>
                (string?)d["key"] == "session-abc" &&
                d.ContainsKey("deleteTranscript") && (bool)d["deleteTranscript"]! == true),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    // ── CompactAsync ──────────────────────────────────────────────────────────

    [Fact]
    public async Task CompactAsync_DefaultMaxLines_Sends400()
    {
        await SessionActions.CompactAsync(_channel, "main");

        await _channel.Received(1).RequestRawAsync(
            "sessions.compact",
            Arg.Is<Dictionary<string, object?>>(d =>
                (string?)d["key"] == "main" &&
                (int)d["maxLines"]! == 400),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CompactAsync_CustomMaxLines_SendsCustomValue()
    {
        await SessionActions.CompactAsync(_channel, "main", maxLines: 100);

        await _channel.Received(1).RequestRawAsync(
            "sessions.compact",
            Arg.Is<Dictionary<string, object?>>(d => (int)d["maxLines"]! == 100),
            Arg.Any<int?>(),
            Arg.Any<CancellationToken>());
    }

    // ── Constants ─────────────────────────────────────────────────────────────

    [Fact]
    public void DefaultCompactMaxLines_Is400()
        => SessionActions.DefaultCompactMaxLines.Should().Be(400);

    [Fact]
    public void DeleteIncludesTranscript_IsTrue()
        => SessionActions.DeleteIncludesTranscript.Should().BeTrue();

    // ── OpenSessionLogInEditor ────────────────────────────────────────────────

    [Fact]
    public void OpenSessionLogInEditor_NoFileExists_ReturnsFalse()
    {
        // Non-existent session id — neither candidate path will exist
        var result = SessionActions.OpenSessionLogInEditor(
            "nonexistent-session-id-zzz",
            storePath: null);

        result.Should().BeFalse();
    }

    [Fact]
    public void OpenSessionLogInEditor_NonexistentStorePath_ReturnsFalse()
    {
        var result = SessionActions.OpenSessionLogInEditor(
            "nonexistent-session-id-zzz",
            storePath: @"C:\no-such-dir\store.json");

        result.Should().BeFalse();
    }
}
