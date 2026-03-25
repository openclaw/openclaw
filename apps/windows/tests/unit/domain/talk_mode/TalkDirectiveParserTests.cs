using OpenClawWindows.Domain.TalkMode;

namespace OpenClawWindows.Tests.Unit.Domain.TalkMode;

public sealed class TalkDirectiveParserTests
{
    // ── No directive ──────────────────────────────────────────────────────────

    [Fact]
    public void Parse_PlainText_NoDirective()
    {
        var r = TalkDirectiveParser.Parse("Hello, world!");

        r.Directive.Should().BeNull();
        r.Stripped.Should().Be("Hello, world!");
        r.UnknownKeys.Should().BeEmpty();
    }

    [Fact]
    public void Parse_EmptyString_NoDirective()
    {
        var r = TalkDirectiveParser.Parse("");
        r.Directive.Should().BeNull();
    }

    [Fact]
    public void Parse_OnlyWhitespace_NoDirective()
    {
        var r = TalkDirectiveParser.Parse("   \n  ");
        r.Directive.Should().BeNull();
    }

    [Fact]
    public void Parse_JsonWithNoRecognizedFields_NoDirective()
    {
        // An object with only unknown keys is not treated as a directive.
        var r = TalkDirectiveParser.Parse("{\"unknownKey\":\"value\"}\nText");
        r.Directive.Should().BeNull();
    }

    [Fact]
    public void Parse_MalformedJson_NoDirective()
    {
        var r = TalkDirectiveParser.Parse("{broken_json}\nText");
        r.Directive.Should().BeNull();
    }

    [Fact]
    public void Parse_LineNotStartingWithBrace_NoDirective()
    {
        var r = TalkDirectiveParser.Parse("hello {\"voice\":\"id\"}\nText");
        r.Directive.Should().BeNull();
    }

    // ── Voice field ───────────────────────────────────────────────────────────

    [Fact]
    public void Parse_VoiceField_ExtractsVoiceId()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"alice1234567\"}\nHello");

        r.Directive.Should().NotBeNull();
        r.Directive!.VoiceId.Should().Be("alice1234567");
    }

    [Fact]
    public void Parse_VoiceIdAlias_ExtractsVoiceId()
    {
        // voice_id and voiceId are alternative keys for the same field.
        var r = TalkDirectiveParser.Parse("{\"voice_id\":\"myvoice1234\"}\nHello");
        r.Directive!.VoiceId.Should().Be("myvoice1234");
    }

    // ── Model field ───────────────────────────────────────────────────────────

    [Fact]
    public void Parse_ModelField_ExtractsModelId()
    {
        var r = TalkDirectiveParser.Parse("{\"model\":\"eleven_v3\"}\nSome text");
        r.Directive!.ModelId.Should().Be("eleven_v3");
    }

    // ── Once / speaker_boost / no_speaker_boost ───────────────────────────────

    [Fact]
    public void Parse_OnceTrue_DirectiveOnceIsTrue()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"once\":true}\nText");
        r.Directive!.Once.Should().BeTrue();
    }

    [Fact]
    public void Parse_SpeakerBoostTrue_SpeakerBoostIsTrue()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"speaker_boost\":true}\nText");
        r.Directive!.SpeakerBoost.Should().BeTrue();
    }

    [Fact]
    public void Parse_NoSpeakerBoostTrue_SpeakerBoostIsFalse()
    {
        // no_speaker_boost:true → SpeakerBoost = false (inverted).
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"no_speaker_boost\":true}\nText");
        r.Directive!.SpeakerBoost.Should().BeFalse();
    }

    // ── Numeric fields ────────────────────────────────────────────────────────

    [Fact]
    public void Parse_SpeedField_ExtractsSpeed()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"speed\":1.2}\nText");
        r.Directive!.Speed.Should().BeApproximately(1.2, 0.001);
    }

    [Fact]
    public void Parse_StabilityField_ExtractsStability()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"stability\":0.75}\nText");
        r.Directive!.Stability.Should().BeApproximately(0.75, 0.001);
    }

    // ── Stripped text ─────────────────────────────────────────────────────────

    [Fact]
    public void Parse_DirectiveLine_IsRemovedFromStripped()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\"}\nHello, world!");
        r.Stripped.Should().Contain("Hello, world!");
        r.Stripped.Should().NotContain("voice");
    }

    [Fact]
    public void Parse_BlankLineAfterDirective_IsAlsoStripped()
    {
        // The blank separator line between directive and body is removed.
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\"}\n\nHello");
        r.Stripped.Should().Be("Hello");
    }

    [Fact]
    public void Parse_NoBlankSeparator_BodyStartsOnNextLine()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\"}\nFirst line\nSecond line");
        r.Stripped.Should().Be("First line\nSecond line");
    }

    // ── CRLF normalization ────────────────────────────────────────────────────

    [Fact]
    public void Parse_CrlfLineEndings_Normalized()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\"}\r\nHello");

        r.Directive.Should().NotBeNull();
        r.Stripped.Should().Contain("Hello");
    }

    // ── Unknown keys ──────────────────────────────────────────────────────────

    [Fact]
    public void Parse_UnknownKey_ReportedInUnknownKeys()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"xyz\":1}\nText");
        r.UnknownKeys.Should().Contain("xyz");
    }

    [Fact]
    public void Parse_AllKnownKeys_EmptyUnknownKeys()
    {
        var r = TalkDirectiveParser.Parse("{\"voice\":\"abc1234567\",\"once\":true}\nText");
        r.UnknownKeys.Should().BeEmpty();
    }

    // ── Leading blank lines ───────────────────────────────────────────────────

    [Fact]
    public void Parse_LeadingBlankLines_DirectiveStillParsed()
    {
        // Leading blank lines are skipped; directive on the first non-empty line is found.
        var r = TalkDirectiveParser.Parse("\n\n{\"voice\":\"abc1234567\"}\nText");

        r.Directive.Should().NotBeNull();
        r.Directive!.VoiceId.Should().Be("abc1234567");
    }
}
