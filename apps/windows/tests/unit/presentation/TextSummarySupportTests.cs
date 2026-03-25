using OpenClawWindows.Presentation.Formatters;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class TextSummarySupportTests
{
    // Null when no non-empty lines
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("\n\n")]
    [InlineData("  \n  \n  ")]
    public void SummarizeLastLine_ReturnsNull_WhenNoNonEmptyLines(string text)
        => Assert.Null(TextSummarySupport.SummarizeLastLine(text));

    // Returns last non-empty line
    [Fact]
    public void SummarizeLastLine_ReturnsLastNonEmptyLine()
        => Assert.Equal("world", TextSummarySupport.SummarizeLastLine("hello\nworld"));

    // Skips trailing blank lines
    [Fact]
    public void SummarizeLastLine_SkipsTrailingBlankLines()
        => Assert.Equal("hello", TextSummarySupport.SummarizeLastLine("hello\n\n   \n"));

    // Normalizes internal whitespace
    [Fact]
    public void SummarizeLastLine_NormalizesWhitespace()
        => Assert.Equal("a b c", TextSummarySupport.SummarizeLastLine("a   b\t\tc"));

    // Truncates at maxLength-1 chars + ellipsis (default 200)
    [Fact]
    public void SummarizeLastLine_Truncates_WhenExceedsDefaultMaxLength()
    {
        var input = new string('a', 201);
        var result = TextSummarySupport.SummarizeLastLine(input)!;
        Assert.Equal(200, result.Length);
        Assert.EndsWith("…", result);
        Assert.Equal(new string('a', 199) + "…", result);
    }

    // Exact length — no truncation
    [Fact]
    public void SummarizeLastLine_DoesNotTruncate_WhenExactlyMaxLength()
    {
        var input = new string('a', 200);
        Assert.Equal(input, TextSummarySupport.SummarizeLastLine(input));
    }

    // Custom maxLength
    [Fact]
    public void SummarizeLastLine_TruncatesAtCustomMaxLength()
    {
        var result = TextSummarySupport.SummarizeLastLine("hello world", maxLength: 6)!;
        Assert.Equal("hello…", result);
        Assert.Equal(6, result.Length);
    }

    // Works with \r\n line endings
    [Fact]
    public void SummarizeLastLine_HandlesCarriageReturnNewline()
        => Assert.Equal("second", TextSummarySupport.SummarizeLastLine("first\r\nsecond"));

    // Single non-empty line
    [Fact]
    public void SummarizeLastLine_ReturnsSingleLine()
        => Assert.Equal("hello", TextSummarySupport.SummarizeLastLine("hello"));
}
