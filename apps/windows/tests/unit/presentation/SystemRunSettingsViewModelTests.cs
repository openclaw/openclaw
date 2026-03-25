using FluentAssertions;
using OpenClawWindows.Application.ExecApprovals;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class SystemRunSettingsViewModelTests
{
    private static SystemRunSettingsViewModel MakeVm(out ISender sender, out IConfigStore configStore)
    {
        sender      = Substitute.For<ISender>();
        configStore = Substitute.For<IConfigStore>();
        return new SystemRunSettingsViewModel(sender, configStore);
    }

    private static ExecApprovalsSnapshot MakeSnapshot(ExecApprovalsFile? file = null, string hash = "h1") => new()
    {
        Path   = "/path/to/exec-approvals.json",
        Exists = true,
        Hash   = hash,
        File   = file ?? new ExecApprovalsFile { Version = 1 }
    };

    private static void SetupGet(ISender sender, ExecApprovalsSnapshot snap) =>
        sender.Send(Arg.Any<GetExecApprovalsQuery>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<ExecApprovalsSnapshot>>(snap));

    private static void SetupSet(ISender sender, ExecApprovalsSnapshot snap) =>
        sender.Send(Arg.Any<SetExecApprovalsCommand>(), Arg.Any<CancellationToken>())
              .Returns(Task.FromResult<ErrorOr<ExecApprovalsSnapshot>>(snap));

    private static Dictionary<string, object?> EmptyConfig() => new();

    private static Dictionary<string, object?> ConfigWithAgents(params (string id, bool isDefault)[] agents)
    {
        var list = agents
            .Select(a =>
            {
                var entry = new Dictionary<string, object?> { ["id"] = a.id };
                if (a.isDefault) entry["default"] = true;
                return (object?)entry;
            })
            .ToList();
        return new Dictionary<string, object?>
        {
            ["agents"] = new Dictionary<string, object?> { ["list"] = list }
        };
    }

    // ── Construction ─────────────────────────────────────────────────────────

    [Fact]
    public void Ctor_DefaultState()
    {
        var vm = MakeVm(out _, out _);

        vm.AgentIds.Should().Equal(new List<string> { "main" });
        vm.SelectedAgentId.Should().Be("main");
        vm.DefaultAgentId.Should().Be("main");
        vm.Security.Should().Be(ExecSecurity.Deny);
        vm.Ask.Should().Be(ExecAsk.OnMiss);
        vm.AskFallback.Should().Be(ExecSecurity.Deny);
        vm.AutoAllowSkills.Should().BeFalse();
        vm.IsLoading.Should().BeFalse();
        vm.AllowlistValidationMessage.Should().BeNull();
        vm.Entries.Should().BeEmpty();
    }

    // ── RefreshAgentsAsync ────────────────────────────────────────────────────

    [Fact]
    public async Task RefreshAgents_EmptyConfig_UsesFallbackAgent()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));

        await vm.RefreshAgentsAsync();

        vm.AgentIds.Should().Equal(new List<string> { "main" });
        vm.DefaultAgentId.Should().Be("main");
    }

    [Fact]
    public async Task RefreshAgents_ParsesAgentList()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(ConfigWithAgents(("alice", false), ("bob", false))));

        await vm.RefreshAgentsAsync();

        vm.AgentIds.Should().Equal(new List<string> { "alice", "bob" });
        vm.DefaultAgentId.Should().Be("alice");
    }

    [Fact]
    public async Task RefreshAgents_DefaultFlag_SetsDefaultAgentId()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(ConfigWithAgents(("alice", false), ("bob", true))));

        await vm.RefreshAgentsAsync();

        vm.DefaultAgentId.Should().Be("bob");
    }

    [Fact]
    public async Task RefreshAgents_CurrentNotInList_ResetsToDefault()
    {
        // "main" (initial) is not in the loaded list → resets to the default agent
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(ConfigWithAgents(("alice", false), ("bob", true))));

        await vm.RefreshAgentsAsync();

        vm.SelectedAgentId.Should().Be("bob");
    }

    [Fact]
    public async Task RefreshAgents_DefaultsScopeSelected_IsPreserved()
    {
        var vm = MakeVm(out _, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(ConfigWithAgents(("alice", false))));
        // Manually put vm into defaults scope before the refresh.
        vm.SelectedAgentId = "__defaults__";

        await vm.RefreshAgentsAsync();

        vm.SelectedAgentId.Should().Be("__defaults__");
    }

    [Fact]
    public async Task RefreshAgents_DuplicateIds_AreDeduped()
    {
        var vm = MakeVm(out _, out var store);
        var list = new List<object?>
        {
            new Dictionary<string, object?> { ["id"] = "alice" },
            new Dictionary<string, object?> { ["id"] = "alice" } // duplicate
        };
        store.LoadAsync(Arg.Any<CancellationToken>())
             .Returns(Task.FromResult(new Dictionary<string, object?>
             {
                 ["agents"] = new Dictionary<string, object?> { ["list"] = list }
             }));

        await vm.RefreshAgentsAsync();

        vm.AgentIds.Should().Equal(new List<string> { "alice" });
    }

    // ── AgentPickerIds / IsDefaultsScope ─────────────────────────────────────

    [Fact]
    public void AgentPickerIds_PrependsSentinel()
    {
        var vm = MakeVm(out _, out _);
        vm.AgentPickerIds.Should().StartWith("__defaults__");
    }

    [Fact]
    public void IsDefaultsScope_TrueWhenSentinelSelected()
    {
        var vm = MakeVm(out _, out _);
        vm.SelectedAgentId = "__defaults__";
        vm.IsDefaultsScope.Should().BeTrue();
    }

    [Fact]
    public void IsDefaultsScope_FalseForRealAgent()
    {
        var vm = MakeVm(out _, out _);
        vm.IsDefaultsScope.Should().BeFalse();
    }

    // ── LoadSettingsForAgent ──────────────────────────────────────────────────

    [Fact]
    public async Task LoadSettings_DefaultsScope_ReadsFromDefaults()
    {
        var file = new ExecApprovalsFile
        {
            Version  = 1,
            Defaults = new ExecApprovalsDefaults
                { Security = ExecSecurity.Full, Ask = ExecAsk.Always, AskFallback = ExecSecurity.Full, AutoAllowSkills = true }
        };
        var snap = MakeSnapshot(file);
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);

        await vm.RefreshAsync();
        vm.SelectedAgentId = "__defaults__";
        vm.LoadSettingsForAgent("__defaults__");

        vm.Security.Should().Be(ExecSecurity.Full);
        vm.Ask.Should().Be(ExecAsk.Always);
        vm.AskFallback.Should().Be(ExecSecurity.Full);
        vm.AutoAllowSkills.Should().BeTrue();
        vm.Entries.Should().BeEmpty();
    }

    [Fact]
    public async Task LoadSettings_Agent_LoadsWithDefaultFallback()
    {
        var file = new ExecApprovalsFile
        {
            Version  = 1,
            Defaults = new ExecApprovalsDefaults { Security = ExecSecurity.Full, AutoAllowSkills = true },
            Agents   = new Dictionary<string, ExecApprovalsAgent>
            {
                ["main"] = new ExecApprovalsAgent() // all nulls → falls through to defaults
            }
        };
        var snap = MakeSnapshot(file);
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);

        await vm.RefreshAsync();
        vm.LoadSettingsForAgent("main");

        vm.Security.Should().Be(ExecSecurity.Full);        // from defaults
        vm.AutoAllowSkills.Should().BeTrue();              // from defaults
    }

    [Fact]
    public async Task LoadSettings_Agent_PopulatesAndSortsEntries()
    {
        var file = new ExecApprovalsFile
        {
            Version = 1,
            Agents  = new Dictionary<string, ExecApprovalsAgent>
            {
                ["main"] = new ExecApprovalsAgent
                {
                    Allowlist =
                    [
                        new ExecAllowlistEntry { Id = Guid.NewGuid(), Pattern = "/z/zzz" },
                        new ExecAllowlistEntry { Id = Guid.NewGuid(), Pattern = "/a/aaa" }
                    ]
                }
            }
        };
        var snap = MakeSnapshot(file);
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);

        await vm.RefreshAsync();

        vm.Entries.Should().HaveCount(2);
        vm.Entries[0].Pattern.Should().Be("/a/aaa");
        vm.Entries[1].Pattern.Should().Be("/z/zzz");
    }

    // ── Set* persistence ──────────────────────────────────────────────────────

    [Fact]
    public async Task SetSecurity_UpdatesPropertyAndPersists()
    {
        var snap = MakeSnapshot();
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync();

        await vm.SetSecurityAsync(ExecSecurity.Full);

        vm.Security.Should().Be(ExecSecurity.Full);
        await sender.Received(1).Send(Arg.Any<SetExecApprovalsCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetAsk_UpdatesPropertyAndPersists()
    {
        var snap = MakeSnapshot();
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync();

        await vm.SetAskAsync(ExecAsk.Always);

        vm.Ask.Should().Be(ExecAsk.Always);
        await sender.Received(1).Send(Arg.Any<SetExecApprovalsCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetAskFallback_UpdatesPropertyAndPersists()
    {
        var snap = MakeSnapshot();
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync();

        await vm.SetAskFallbackAsync(ExecSecurity.Full);

        vm.AskFallback.Should().Be(ExecSecurity.Full);
        await sender.Received(1).Send(Arg.Any<SetExecApprovalsCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SetAutoAllowSkills_UpdatesPropertyAndPersists()
    {
        var snap = MakeSnapshot();
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync();

        await vm.SetAutoAllowSkillsAsync(true);

        vm.AutoAllowSkills.Should().BeTrue();
        await sender.Received(1).Send(Arg.Any<SetExecApprovalsCommand>(), Arg.Any<CancellationToken>());
    }

    // ── AddEntryAsync ─────────────────────────────────────────────────────────

    [Fact]
    public async Task AddEntry_ValidPattern_AddsEntryAndReturnsNull()
    {
        var snap = MakeSnapshot();
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync(); // SelectedAgentId = "main"

        var result = await vm.AddEntryAsync("/usr/bin/bash");

        result.Should().BeNull();
        vm.Entries.Should().ContainSingle(e => e.Pattern == "/usr/bin/bash");
    }

    [Fact]
    public async Task AddEntry_EmptyPattern_SetsValidationMessage()
    {
        var vm = MakeVm(out _, out _);

        var result = await vm.AddEntryAsync("");

        result.Should().Be(ExecAllowlistPatternValidationReason.Empty);
        vm.AllowlistValidationMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task AddEntry_BasenameOnly_SetsValidationMessage()
    {
        var vm = MakeVm(out _, out _);

        var result = await vm.AddEntryAsync("echo");

        result.Should().Be(ExecAllowlistPatternValidationReason.MissingPathComponent);
        vm.AllowlistValidationMessage.Should().NotBeNullOrEmpty();
    }

    [Fact]
    public async Task AddEntry_DefaultsScope_IsNoop()
    {
        var vm = MakeVm(out _, out _);
        vm.SelectedAgentId = "__defaults__";

        var result = await vm.AddEntryAsync("/usr/bin/bash");

        result.Should().BeNull();
        vm.Entries.Should().BeEmpty();
    }

    // ── UpdateEntryAsync ──────────────────────────────────────────────────────

    [Fact]
    public async Task UpdateEntry_ValidPattern_UpdatesEntry()
    {
        var entryId = Guid.NewGuid();
        var file    = new ExecApprovalsFile
        {
            Version = 1,
            Agents  = new Dictionary<string, ExecApprovalsAgent>
            {
                ["main"] = new ExecApprovalsAgent
                {
                    Allowlist = [new ExecAllowlistEntry { Id = entryId, Pattern = "/old/path" }]
                }
            }
        };
        var snap = MakeSnapshot(file);
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync();

        var result = await vm.UpdateEntryAsync(entryId, "/new/path");

        result.Should().BeNull();
        vm.Entries.Should().ContainSingle(e => e.Id == entryId && e.Pattern == "/new/path");
    }

    [Fact]
    public async Task UpdateEntry_UnknownId_IsNoop()
    {
        var snap = MakeSnapshot();
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        await vm.RefreshAsync();

        var result = await vm.UpdateEntryAsync(Guid.NewGuid(), "/some/path");

        result.Should().BeNull();
        vm.Entries.Should().BeEmpty();
    }

    [Fact]
    public async Task UpdateEntry_DefaultsScope_IsNoop()
    {
        var vm = MakeVm(out _, out _);
        vm.SelectedAgentId = "__defaults__";

        var result = await vm.UpdateEntryAsync(Guid.NewGuid(), "/some/path");

        result.Should().BeNull();
    }

    // ── RemoveEntryAsync ──────────────────────────────────────────────────────

    [Fact]
    public async Task RemoveEntry_RemovesEntryAndPersists()
    {
        var entryId = Guid.NewGuid();
        var file    = new ExecApprovalsFile
        {
            Version = 1,
            Agents  = new Dictionary<string, ExecApprovalsAgent>
            {
                ["main"] = new ExecApprovalsAgent
                {
                    Allowlist = [new ExecAllowlistEntry { Id = entryId, Pattern = "/usr/bin/bash" }]
                }
            }
        };
        var snap = MakeSnapshot(file);
        var vm   = MakeVm(out var sender, out var store);
        store.LoadAsync(Arg.Any<CancellationToken>()).Returns(Task.FromResult(EmptyConfig()));
        SetupGet(sender, snap);
        SetupSet(sender, snap);
        await vm.RefreshAsync();

        await vm.RemoveEntryAsync(entryId);

        vm.Entries.Should().BeEmpty();
        await sender.Received(1).Send(Arg.Any<SetExecApprovalsCommand>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task RemoveEntry_DefaultsScope_IsNoop()
    {
        var vm = MakeVm(out _, out _);
        vm.SelectedAgentId = "__defaults__";

        await vm.RemoveEntryAsync(Guid.NewGuid()); // should not throw
    }

    // ── Label / IsPathPattern helpers ─────────────────────────────────────────

    [Fact]
    public void Label_DefaultsSentinel_ReturnsDefaults()
    {
        var vm = MakeVm(out _, out _);
        vm.Label("__defaults__").Should().Be("Defaults");
    }

    [Fact]
    public void Label_AgentId_ReturnsSameId()
    {
        var vm = MakeVm(out _, out _);
        vm.Label("my-agent").Should().Be("my-agent");
    }

    [Fact]
    public void IsPathPattern_PathWithSlash_ReturnsTrue()
    {
        var vm = MakeVm(out _, out _);
        vm.IsPathPattern("/usr/bin/bash").Should().BeTrue();
    }

    [Fact]
    public void IsPathPattern_BasenameOnly_ReturnsFalse()
    {
        var vm = MakeVm(out _, out _);
        vm.IsPathPattern("echo").Should().BeFalse();
    }
}
