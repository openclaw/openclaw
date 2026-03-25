using OpenClawWindows.Presentation.Helpers;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SettingsWindowOpenerTests
{
    // Use a fresh instance per test to avoid Shared singleton cross-test state pollution.
    private readonly SettingsWindowOpener _opener = new();

    [Fact]
    public void Open_WithRegisteredAction_InvokesAction()
    {
        var called = false;
        _opener.Register(() => called = true);

        _opener.Open();

        Assert.True(called);
    }

    [Fact]
    public void Open_WithoutRegisteredAction_DoesNotThrow()
    {
        // Swift fallback (NSApp.sendAction) has no Windows equivalent → no-op
        var ex = Record.Exception(() => _opener.Open());
        Assert.Null(ex);
    }

    [Fact]
    public void Open_CalledMultipleTimes_InvokesActionEachTime()
    {
        var count = 0;
        _opener.Register(() => count++);

        _opener.Open();
        _opener.Open();

        Assert.Equal(2, count);
    }

    [Fact]
    public void Register_OverwritesPreviousAction()
    {
        var firstCalled = false;
        var secondCalled = false;
        _opener.Register(() => firstCalled = true);
        _opener.Register(() => secondCalled = true);

        _opener.Open();

        Assert.False(firstCalled);
        Assert.True(secondCalled);
    }

    [Fact]
    public void Shared_IsSameInstance()
    {
        // Mirrors Swift: static let shared — always same reference
        Assert.Same(SettingsWindowOpener.Shared, SettingsWindowOpener.Shared);
    }
}
