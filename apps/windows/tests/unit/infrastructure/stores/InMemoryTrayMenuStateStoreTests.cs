using OpenClawWindows.Domain.SystemTray;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemoryTrayMenuStateStoreTests
{
    private static InMemoryTrayMenuStateStore Make() => new();

    [Fact]
    public void Current_Initially_IsNull()
    {
        var store = Make();
        store.Current.Should().BeNull();
    }

    [Fact]
    public void Update_SetsCurrent()
    {
        var store = Make();
        var state = TrayMenuState.Create("Connected", "1 session(s)", null, 1, null, false);

        store.Update(state);

        store.Current.Should().Be(state);
    }

    [Fact]
    public void Update_Overwrites_PreviousState()
    {
        var store = Make();
        var first  = TrayMenuState.Disconnected();
        var second = TrayMenuState.Create("Connected", "1 session(s)", null, 1, null, false);

        store.Update(first);
        store.Update(second);

        store.Current.Should().Be(second);
    }
}
