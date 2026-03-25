using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class ChatMarkdownPreprocessorTests
{
    // ── StripSystemContextLines ──────────────────────────────────────────────

    [Fact]
    public void Preprocess_RemovesSystemContextLine_LeavingUserText()
    {
        var raw =
            "System: [2026-03-21 08:34:56 GMT+1] Node: ALEXALVES87 (192.168.1.18) · app 1.0.0 · mode local · reason launch\n\nhola";
        var result = ChatMarkdownPreprocessor.Preprocess(raw);
        Assert.Equal("hola", result);
    }

    [Fact]
    public void Preprocess_RemovesMultipleSystemContextLines()
    {
        var raw =
            "System: [2026-03-21 09:51:31 GMT+1] Node: ALEXALVES87 (192.168.1.18) · mode unconfigured\n" +
            "System: [2026-03-21 09:58:36 GMT+1] Node: ALEXALVES87 (192.168.1.18) · app 1.0.0 · mode local · reason launch\n\nhola";
        var result = ChatMarkdownPreprocessor.Preprocess(raw);
        Assert.Equal("hola", result);
    }

    [Fact]
    public void Preprocess_SystemContextOnly_ReturnsEmpty()
    {
        var raw = "System: [2026-03-21 09:51:31 GMT+1] Node: ALEXALVES87 (192.168.1.18) · mode unconfigured";
        var result = ChatMarkdownPreprocessor.Preprocess(raw);
        Assert.Equal(string.Empty, result);
    }

    [Fact]
    public void Preprocess_NoSystemContext_PassesThrough()
    {
        var raw = "hola, cómo estás?";
        var result = ChatMarkdownPreprocessor.Preprocess(raw);
        Assert.Equal("hola, cómo estás?", result);
    }

    [Fact]
    public void Preprocess_SystemContextWithExecCompleted_IsRemoved()
    {
        var raw =
            "System: [2026-03-21 08:40:40 GMT+1] Exec completed (tide-mis, code 0) :: | 22k/272k (8%)\n\nhola";
        var result = ChatMarkdownPreprocessor.Preprocess(raw);
        Assert.Equal("hola", result);
    }
}
