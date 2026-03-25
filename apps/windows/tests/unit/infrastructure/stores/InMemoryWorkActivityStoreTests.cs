using System.Text.Json;
using OpenClawWindows.Infrastructure.Stores;

namespace OpenClawWindows.Tests.Unit.Infrastructure.Stores;

public sealed class InMemoryWorkActivityStoreTests
{
    private static InMemoryWorkActivityStore Make() => new();

    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void InitialState_IsIdle()
    {
        var store = Make();
        store.IconState.Should().BeOfType<IconState.Idle>();
        store.Current.Should().BeNull();
    }

    // ── HandleJob ─────────────────────────────────────────────────────────────

    [Fact]
    public void HandleJob_Started_SetsWorkingMain()
    {
        var store = Make();
        store.HandleJob("main", "started");

        store.IconState.Should().BeOfType<IconState.WorkingMain>();
        store.Current.Should().NotBeNull();
        store.Current!.Kind.Should().BeOfType<ActivityKind.Job>();
    }

    [Fact]
    public void HandleJob_Streaming_SetsWorkingMain()
    {
        var store = Make();
        store.HandleJob("main", "streaming");

        store.IconState.Should().BeOfType<IconState.WorkingMain>();
    }

    [Fact]
    public void HandleJob_Done_ClearsActivity()
    {
        var store = Make();
        store.HandleJob("main", "started");
        store.HandleJob("main", "done");

        store.IconState.Should().BeOfType<IconState.Idle>();
        store.Current.Should().BeNull();
    }

    [Fact]
    public void HandleJob_Error_ClearsActivity()
    {
        var store = Make();
        store.HandleJob("main", "started");
        store.HandleJob("main", "error");

        store.IconState.Should().BeOfType<IconState.Idle>();
    }

    [Fact]
    public void HandleJob_OtherSession_SetsWorkingOther()
    {
        var store = Make();
        // main session is "main" by default
        store.HandleJob("secondary", "started");

        store.IconState.Should().BeOfType<IconState.WorkingOther>();
    }

    [Fact]
    public void HandleJob_MainPreemptsOther()
    {
        var store = Make();
        store.HandleJob("other-session", "started");
        store.HandleJob("main", "started");

        // Main session should take over CurrentActivity
        store.Current!.SessionKey.Should().Be("main");
        store.IconState.Should().BeOfType<IconState.WorkingMain>();
    }

    [Fact]
    public void HandleJob_Started_FiresStateChanged()
    {
        var store = Make();
        var fired = 0;
        store.StateChanged += (_, _) => fired++;

        store.HandleJob("main", "started");

        fired.Should().Be(1);
    }

    // ── HandleTool ────────────────────────────────────────────────────────────

    [Fact]
    public void HandleTool_Start_SetsToolLabel()
    {
        var store = Make();
        store.HandleJob("main", "started");
        store.HandleTool("main", "start", "bash", null, null);

        store.LastToolLabel.Should().Be("Bash");
        store.Current!.Kind.Should().BeOfType<ActivityKind.Tool>();
    }

    [Fact]
    public void HandleTool_Start_WithMeta_IncludesDetailInLabel()
    {
        var store = Make();
        store.HandleJob("main", "started");
        store.HandleTool("main", "start", "read", "src/app.cs", null);

        store.LastToolLabel.Should().Be("Read: src/app.cs");
    }

    [Fact]
    public void HandleTool_Start_BashCommand_ExtractsFromArgs()
    {
        var store = Make();
        store.HandleJob("main", "started");
        var args = JsonDocument.Parse("""{"command":"ls -la"}""").RootElement;
        store.HandleTool("main", "start", "bash", null, args);

        store.LastToolLabel.Should().Be("Bash: ls -la");
    }

    [Fact]
    public void HandleTool_Start_TruncatesLongDetail()
    {
        var store = Make();
        store.HandleJob("main", "started");
        var longMeta = new string('x', 100);
        store.HandleTool("main", "start", "read", longMeta, null);

        store.LastToolLabel!.Length.Should().BeLessOrEqualTo(100); // "Read: " + 80 chars + "…"
        store.LastToolLabel.Should().EndWith("…");
    }

    [Fact]
    public void HandleTool_Start_FiresStateChanged()
    {
        var store = Make();
        store.HandleJob("main", "started");
        var fired = 0;
        store.StateChanged += (_, _) => fired++;

        store.HandleTool("main", "start", "write", null, null);

        fired.Should().BeGreaterThan(0);
    }

    // ── SetMainSessionKey ─────────────────────────────────────────────────────

    [Fact]
    public void SetMainSessionKey_ChangesRoleForExistingJob()
    {
        var store = Make();
        store.HandleJob("session-abc", "started");

        // Before update: session-abc is "other"
        store.IconState.Should().BeOfType<IconState.WorkingOther>();

        store.SetMainSessionKey("session-abc");

        // After update: session-abc is now main
        store.IconState.Should().BeOfType<IconState.WorkingMain>();
    }

    [Fact]
    public void SetMainSessionKey_Empty_IsIgnored()
    {
        var store = Make();
        store.HandleJob("main", "started");

        store.SetMainSessionKey("");

        store.MainSessionKey.Should().Be("main");
    }

    [Fact]
    public void SetMainSessionKey_Whitespace_IsIgnored()
    {
        var store = Make();
        store.SetMainSessionKey("   ");
        store.MainSessionKey.Should().Be("main");
    }

    // ── ResolveIconState ──────────────────────────────────────────────────────

    [Fact]
    public void ResolveIconState_System_WhenIdle_RemainsIdle()
    {
        var store = Make();
        store.ResolveIconState(IconOverrideSelection.System);
        store.IconState.Should().BeOfType<IconState.Idle>();
    }

    [Fact]
    public void ResolveIconState_Override_WhenWorking_SetsOverridden()
    {
        var store = Make();
        store.HandleJob("main", "started");

        store.ResolveIconState(IconOverrideSelection.MainBash);

        store.IconState.Should().BeOfType<IconState.Overridden>();
    }

    [Fact]
    public void ResolveIconState_System_AfterOverride_Reverts()
    {
        var store = Make();
        store.HandleJob("main", "started");
        store.ResolveIconState(IconOverrideSelection.MainBash);

        store.ResolveIconState(IconOverrideSelection.System);

        store.IconState.Should().BeOfType<IconState.WorkingMain>();
    }
}
