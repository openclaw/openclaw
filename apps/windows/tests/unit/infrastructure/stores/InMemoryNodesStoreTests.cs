using OpenClawWindows.Domain.Nodes;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

// Mirrors NodesStore.swift state management — Apply / SetError / SetCancelled / SetLoading.
public sealed class InMemoryNodesStoreTests
{
    private static NodeInfo MakeNode(string id) => new(
        NodeId:          id,
        DisplayName:     null,
        Platform:        null,
        Version:         null,
        CoreVersion:     null,
        UiVersion:       null,
        DeviceFamily:    null,
        ModelIdentifier: null,
        RemoteIp:        null,
        Caps:            null,
        Commands:        null,
        Permissions:     null,
        Paired:          null,
        Connected:       null);

    [Fact]
    public void Apply_SetsNodesAndClearsErrorAndStatus()
    {
        var store = new InMemoryNodesStore();
        store.SetError("prev error");

        store.Apply([MakeNode("n1"), MakeNode("n2")]);

        Assert.Equal(2, store.Nodes.Count);
        Assert.Null(store.LastError);
        Assert.Null(store.StatusMessage);
        Assert.False(store.IsLoading);
    }

    [Fact]
    public void SetError_ClearsNodesAndSetsError()
    {
        var store = new InMemoryNodesStore();
        store.Apply([MakeNode("n1")]);

        store.SetError("connection refused");

        Assert.Empty(store.Nodes);
        Assert.Equal("connection refused", store.LastError);
        Assert.Null(store.StatusMessage);
        Assert.False(store.IsLoading);
    }

    [Fact]
    public void SetCancelled_WithEmptyNodes_SetsStatusMessage()
    {
        var store = new InMemoryNodesStore();

        // Mirrors Swift: if nodes.isEmpty → statusMessage = "Refreshing devices…"
        store.SetCancelled("Refreshing devices\u2026");

        Assert.Empty(store.Nodes);
        Assert.Null(store.LastError);
        Assert.Equal("Refreshing devices\u2026", store.StatusMessage);
        Assert.False(store.IsLoading);
    }

    [Fact]
    public void SetCancelled_PreservesExistingNodes()
    {
        var store = new InMemoryNodesStore();
        store.Apply([MakeNode("n1")]);

        // Mirrors Swift: when cancelled with nodes present, keep them
        store.SetCancelled(null);

        Assert.Single(store.Nodes);
        Assert.Null(store.LastError);
    }

    [Fact]
    public void SetLoading_UpdatesFlag()
    {
        var store = new InMemoryNodesStore();

        store.SetLoading(true);
        Assert.True(store.IsLoading);

        store.SetLoading(false);
        Assert.False(store.IsLoading);
    }

    [Fact]
    public void NodesChanged_RaisedOnApply()
    {
        var store = new InMemoryNodesStore();
        int count = 0;
        store.NodesChanged += (_, _) => count++;

        store.Apply([MakeNode("n1")]);

        Assert.Equal(1, count);
    }

    [Fact]
    public void NodeInfo_IsConnected_DefaultsFalse()
    {
        var node = MakeNode("x");
        Assert.False(node.IsConnected);
        Assert.False(node.IsPaired);
    }

    [Fact]
    public void NodeInfo_IsConnected_ReflectsConnectedField()
    {
        var node = MakeNode("x") with { Connected = true, Paired = true };
        Assert.True(node.IsConnected);
        Assert.True(node.IsPaired);
    }
}
