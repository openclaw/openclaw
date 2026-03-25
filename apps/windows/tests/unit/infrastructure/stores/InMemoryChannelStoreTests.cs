using System.Text.Json;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemoryChannelStoreTests
{
    private static InMemoryChannelStore Make() => new();

    [Fact]
    public void GetActive_Initially_Empty()
    {
        var store = Make();
        store.GetActive().Should().BeEmpty();
    }

    [Fact]
    public void Register_AddsChannel()
    {
        var store = Make();
        store.Register("ch-1");
        store.GetActive().Should().ContainSingle(id => id == "ch-1");
    }

    [Fact]
    public void Register_SameId_NoDuplicate()
    {
        var store = Make();
        store.Register("ch-1");
        store.Register("ch-1");
        store.GetActive().Should().HaveCount(1);
    }

    [Fact]
    public void Unregister_RemovesChannel()
    {
        var store = Make();
        store.Register("ch-1");
        store.Register("ch-2");

        store.Unregister("ch-1");

        store.GetActive().Should().ContainSingle(id => id == "ch-2");
    }

    [Fact]
    public void Unregister_NonExistent_DoesNotThrow()
    {
        var store = Make();
        var act = () => store.Unregister("ch-missing");
        act.Should().NotThrow();
    }

    [Fact]
    public void UpdateSnapshot_SetsSnapshotAndLastSuccess()
    {
        var store = Make();
        using var doc = JsonDocument.Parse("""{"channels":{"c1":{"linked":true}}}""");
        var at = DateTimeOffset.UtcNow;

        store.UpdateSnapshot(doc.RootElement, at);

        store.StatusSnapshot.Should().NotBeNull();
        store.LastSuccess.Should().BeCloseTo(at, TimeSpan.FromSeconds(1));
        store.LastError.Should().BeNull();
    }

    [Fact]
    public void UpdateSnapshot_SnapshotSurvivesDocumentDisposal()
    {
        // Clone must outlive the JsonDocument that created it.
        var store = Make();
        using (var doc = JsonDocument.Parse("""{"key":"value"}"""))
        {
            store.UpdateSnapshot(doc.RootElement, DateTimeOffset.UtcNow);
        }

        // After the using block, the original JsonDocument is disposed.
        // The cloned element must still be readable.
        store.StatusSnapshot.Should().NotBeNull();
        store.StatusSnapshot!.Value.TryGetProperty("key", out var prop).Should().BeTrue();
        prop.GetString().Should().Be("value");
    }

    [Fact]
    public void SetError_SetsLastError()
    {
        var store = Make();
        store.SetError("gateway timeout");
        store.LastError.Should().Be("gateway timeout");
    }

    [Fact]
    public void UpdateSnapshot_ClearsLastError()
    {
        var store = Make();
        store.SetError("previous error");

        using var doc = JsonDocument.Parse("{}");
        store.UpdateSnapshot(doc.RootElement, DateTimeOffset.UtcNow);

        store.LastError.Should().BeNull();
    }
}
