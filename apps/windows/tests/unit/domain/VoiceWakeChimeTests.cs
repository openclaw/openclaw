using OpenClawWindows.Domain.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Domain;

public sealed class VoiceWakeChimeTests
{
    // --- SystemName ---

    [Fact]
    public void SystemName_SystemSoundCase_ReturnsName()
    {
        var chime = new VoiceWakeChime.SystemSound("Windows Ding");
        Assert.Equal("Windows Ding", chime.SystemName);
    }

    [Fact]
    public void SystemName_NoneCase_ReturnsNull()
    {
        var chime = new VoiceWakeChime.None();
        Assert.Null(chime.SystemName);
    }

    [Fact]
    public void SystemName_CustomCase_ReturnsNull()
    {
        var chime = new VoiceWakeChime.Custom("My Sound", []);
        Assert.Null(chime.SystemName);
    }

    // --- DisplayLabel ---

    [Fact]
    public void DisplayLabel_None_IsNoSound()
    {
        // Swift: case .none → "No Sound"
        Assert.Equal("No Sound", new VoiceWakeChime.None().DisplayLabel);
    }

    [Fact]
    public void DisplayLabel_SystemSound_ReturnsName()
    {
        // Swift: VoiceWakeChimeCatalog.displayName(for: name) → returns name as-is
        var chime = new VoiceWakeChime.SystemSound("Windows Ding");
        Assert.Equal("Windows Ding", chime.DisplayLabel);
    }

    [Fact]
    public void DisplayLabel_Custom_ReturnsDisplayName()
    {
        // Swift: case .custom(let displayName, _) → displayName
        var chime = new VoiceWakeChime.Custom("My Alert", [0x01, 0x02]);
        Assert.Equal("My Alert", chime.DisplayLabel);
    }

    // --- Equality (record semantics) ---

    [Fact]
    public void None_Equality_SameInstance()
    {
        Assert.Equal(new VoiceWakeChime.None(), new VoiceWakeChime.None());
    }

    [Fact]
    public void SystemSound_Equality_SameName()
    {
        Assert.Equal(
            new VoiceWakeChime.SystemSound("Ding"),
            new VoiceWakeChime.SystemSound("Ding"));
    }

    [Fact]
    public void SystemSound_Inequality_DifferentName()
    {
        Assert.NotEqual(
            new VoiceWakeChime.SystemSound("Ding"),
            new VoiceWakeChime.SystemSound("Chime"));
    }

    // --- VoiceWakeChimeCatalog ---

    [Fact]
    public void DisplayName_ReturnsRawName()
    {
        // Swift: SoundEffectCatalog.displayName(for:) returns raw unchanged.
        Assert.Equal("Windows Ding", VoiceWakeChimeCatalog.DisplayName("Windows Ding"));
        Assert.Equal("anything", VoiceWakeChimeCatalog.DisplayName("anything"));
    }

    [Fact]
    public void SystemOptions_PinnedDefaultIsFirst()
    {
        // Swift: "Glass" is pinned first; Windows equivalent is "Windows Ding".
        var options = VoiceWakeChimeCatalog.SystemOptions;
        Assert.NotEmpty(options);
        Assert.Equal("Windows Ding", options[0]);
    }

    [Fact]
    public void SystemOptions_RestAreSorted()
    {
        var options = VoiceWakeChimeCatalog.SystemOptions;
        var tail = options.Skip(1).ToList();
        var sorted = tail.OrderBy(n => n, StringComparer.OrdinalIgnoreCase).ToList();
        Assert.Equal(sorted, tail);
    }
}
