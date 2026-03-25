using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemorySessionStoreTests
{
    private static InMemorySessionStore Make() => new();

    [Fact]
    public void ActiveCount_Initially_IsZero()
    {
        var store = Make();
        store.ActiveCount.Should().Be(0);
    }

    [Fact]
    public void Add_IncrementsActiveCount()
    {
        var store = Make();
        store.Add("session-1", DateTimeOffset.UtcNow);
        store.ActiveCount.Should().Be(1);
    }

    [Fact]
    public void Add_SameKey_DoesNotDuplicate()
    {
        var store = Make();
        store.Add("session-1", DateTimeOffset.UtcNow);
        store.Add("session-1", DateTimeOffset.UtcNow.AddSeconds(1));
        store.ActiveCount.Should().Be(1);
    }

    [Fact]
    public void Add_MultipleKeys_CountsAll()
    {
        var store = Make();
        store.Add("s1", DateTimeOffset.UtcNow);
        store.Add("s2", DateTimeOffset.UtcNow);
        store.Add("s3", DateTimeOffset.UtcNow);
        store.ActiveCount.Should().Be(3);
    }

    [Fact]
    public void CloseActive_ClearsAllSessions()
    {
        var store = Make();
        store.Add("s1", DateTimeOffset.UtcNow);
        store.Add("s2", DateTimeOffset.UtcNow);

        store.CloseActive(DateTimeOffset.UtcNow);

        store.ActiveCount.Should().Be(0);
    }

    [Fact]
    public void Add_AfterClose_WorksAgain()
    {
        var store = Make();
        store.Add("s1", DateTimeOffset.UtcNow);
        store.CloseActive(DateTimeOffset.UtcNow);
        store.Add("s2", DateTimeOffset.UtcNow);
        store.ActiveCount.Should().Be(1);
    }
}
