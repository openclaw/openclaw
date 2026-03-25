using System.Text.Json;
using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.NodeMode;

namespace OpenClawWindows.Tests.Unit.Infrastructure.NodeMode;

public sealed class WindowsNodeRuntimeTests
{
    private readonly INodeEventSink _sink = Substitute.For<INodeEventSink>();
    private readonly WindowsNodeRuntime _sut;

    public WindowsNodeRuntimeTests()
    {
        _sut = new WindowsNodeRuntime(new Lazy<INodeEventSink>(() => _sink));
    }

    // ── MainSessionKey default ────────────────────────────────────────────────
    // Mirrors Swift: private var mainSessionKey: String = "main"

    [Fact]
    public void MainSessionKey_DefaultIs_Main()
    {
        Assert.Equal("main", _sut.MainSessionKey);
    }

    // ── UpdateMainSessionKey ──────────────────────────────────────────────────
    // Mirrors Swift: func updateMainSessionKey(_ sessionKey: String)

    [Fact]
    public void UpdateMainSessionKey_SetsKey()
    {
        _sut.UpdateMainSessionKey("session-xyz");
        Assert.Equal("session-xyz", _sut.MainSessionKey);
    }

    [Fact]
    public void UpdateMainSessionKey_TrimsWhitespace()
    {
        _sut.UpdateMainSessionKey("  session-abc  ");
        Assert.Equal("session-abc", _sut.MainSessionKey);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void UpdateMainSessionKey_EmptyOrWhitespace_Ignored(string value)
    {
        // Guard: empty/whitespace-only trimmed values silently ignored — mirrors Swift guard !trimmed.isEmpty
        _sut.UpdateMainSessionKey(value);
        Assert.Equal("main", _sut.MainSessionKey);
    }

    // ── EmitExecEvent ─────────────────────────────────────────────────────────
    // Mirrors Swift: private func emitExecEvent(_ event: String, payload: ExecEventPayload)

    [Fact]
    public void EmitExecEvent_CallsTrySendEventWithSerializedPayload()
    {
        var payload = new ExecEventPayload
        {
            SessionKey = "s1", RunId = "r1", Host = "node",
            Command = "ls -la", Success = true,
        };

        _sut.EmitExecEvent("exec.started", payload);

        _sink.Received(1).TrySendEvent(
            Arg.Is("exec.started"),
            Arg.Is<string?>(json => json != null &&
                json.Contains("\"sessionKey\":\"s1\"") &&
                json.Contains("\"host\":\"node\"")));
    }

    [Fact]
    public void EmitExecEvent_NullFieldsOmittedFromJson()
    {
        // DefaultIgnoreCondition.WhenWritingNull — mirrors Swift's Optional encoding (nil = omitted)
        var payload = new ExecEventPayload { SessionKey = "s2", RunId = "r2", Host = "node" };

        // Capture via When/Do before the call under test
        string? captured = null;
        _sink.When(s => s.TrySendEvent(Arg.Any<string>(), Arg.Any<string?>()))
             .Do(ci => captured = ci.ArgAt<string?>(1));

        _sut.EmitExecEvent("exec.finished", payload);

        Assert.NotNull(captured);
        Assert.DoesNotContain("exitCode", captured);
        Assert.DoesNotContain("timedOut", captured);
        Assert.DoesNotContain("output", captured);
        Assert.DoesNotContain("reason", captured);
    }

    [Fact]
    public void EmitExecEvent_CamelCasePropertyNames()
    {
        var payload = new ExecEventPayload
        {
            SessionKey = "s3", RunId = "r3", Host = "node",
            ExitCode = 0, TimedOut = false, Success = true,
        };

        string? json = null;
        _sink.When(s => s.TrySendEvent(Arg.Any<string>(), Arg.Any<string?>()))
             .Do(ci => json = ci.ArgAt<string?>(1));

        _sut.EmitExecEvent("exec.finished", payload);

        Assert.NotNull(json);
        Assert.Contains("\"sessionKey\"", json);
        Assert.Contains("\"runId\"", json);
        Assert.Contains("\"exitCode\"", json);
        Assert.Contains("\"timedOut\"", json);
        Assert.Contains("\"success\"", json);
    }

    // ── ExecEventPayload.TruncateOutput ───────────────────────────────────────
    // Mirrors Swift: static func truncateOutput(_ raw: String, maxChars: Int = 20000) -> String?

    [Fact]
    public void TruncateOutput_EmptyOrWhitespace_ReturnsNull()
    {
        Assert.Null(ExecEventPayload.TruncateOutput(""));
        Assert.Null(ExecEventPayload.TruncateOutput("   "));
    }

    [Fact]
    public void TruncateOutput_ShortString_ReturnsTrimmed()
    {
        var result = ExecEventPayload.TruncateOutput("  hello  ");
        Assert.Equal("hello", result);
    }

    [Fact]
    public void TruncateOutput_LongString_TruncatesWithPrefix()
    {
        // maxChars = 20000 by default; use small value for test
        var longStr = new string('x', 30);
        var result = ExecEventPayload.TruncateOutput(longStr, maxChars: 10);
        Assert.NotNull(result);
        Assert.StartsWith("... (truncated) ", result);
        // Suffix is last 10 chars
        Assert.EndsWith(new string('x', 10), result);
    }

    [Fact]
    public void TruncateOutput_ExactlyMaxChars_ReturnsUnchanged()
    {
        var str = new string('a', 20_000);
        var result = ExecEventPayload.TruncateOutput(str);
        Assert.Equal(str, result);
    }
}
