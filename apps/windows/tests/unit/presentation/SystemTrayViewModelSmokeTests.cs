using MediatR;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Gateway;
using OpenClawWindows.Application.Lifecycle;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.Health;
using OpenClawWindows.Domain.Nodes;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Domain.Updates;
using OpenClawWindows.Presentation.Tray;
using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Tests.Unit.Presentation;

// Mirrors MenuContentSmokeTests.swift — verifies SystemTrayViewModel can be constructed
// and that computed labels are correct for local / remote / unconfigured / debug+canvas modes.
public sealed class SystemTrayViewModelSmokeTests
{
    // ── Smoke: constructor does not throw ────────────────────────────────────

    [Fact]
    public void Ctor_LocalMode_DoesNotThrow()
    {
        var vm = MakeVm();
        Assert.NotNull(vm.ConnectionLabel);
        Assert.NotNull(vm.HealthStatusLabel);
    }

    [Fact]
    public void Ctor_RemoteMode_DoesNotThrow()
    {
        var vm = MakeVm();
        vm.ConnectionLabel = "Remote OpenClaw Active";
        Assert.NotNull(vm.ConnectionLabel);
    }

    [Fact]
    public void Ctor_UnconfiguredMode_DoesNotThrow()
    {
        var vm = MakeVm();
        vm.ConnectionLabel = "OpenClaw Not Configured";
        Assert.Equal("OpenClaw Not Configured", vm.ConnectionLabel);
    }

    [Fact]
    public void Ctor_DebugAndCanvas_AllLabelsNonNull()
    {
        // Mirrors the debug+canvas smoke in MenuContentSmokeTests.swift.
        var vm = MakeVm();
        vm.DebugPaneEnabled  = true;
        vm.CanvasEnabled     = true;
        vm.IsCanvasPanelVisible = true;
        vm.TalkEnabled       = true;
        vm.HeartbeatsEnabled = true;

        Assert.NotNull(vm.TalkModeLabel);
        Assert.NotNull(vm.OpenCanvasLabel);
        Assert.NotNull(vm.ExecApprovalTitle);
    }

    // ── ConnectionLabel mapping ───────────────────────────────────────────────

    [Fact]
    public void ConnectionLabel_Default_IsNotConfigured()
    {
        Assert.Equal("OpenClaw Not Configured", MakeVm().ConnectionLabel);
    }

    // ── ExecApprovalTitle ────────────────────────────────────────────────────

    [Fact]
    public void ExecApprovalTitle_Deny_ShowsDenyAll()
    {
        var vm = MakeVm();
        vm.ExecApprovalMode = ExecApprovalMode.Deny;
        Assert.Equal("Exec: Deny All", vm.ExecApprovalTitle);
    }

    [Fact]
    public void ExecApprovalTitle_Ask_ShowsAsk()
    {
        var vm = MakeVm();
        vm.ExecApprovalMode = ExecApprovalMode.Ask;
        Assert.Equal("Exec: Ask", vm.ExecApprovalTitle);
    }

    [Fact]
    public void ExecApprovalTitle_Allow_ShowsAllowAll()
    {
        var vm = MakeVm();
        vm.ExecApprovalMode = ExecApprovalMode.Allow;
        Assert.Equal("Exec: Allow All", vm.ExecApprovalTitle);
    }

    // ── TalkModeLabel ─────────────────────────────────────────────────────────

    [Fact]
    public void TalkModeLabel_Inactive_ShowsTalkMode()
    {
        var vm = MakeVm();
        vm.TalkEnabled = false;
        Assert.Equal("Talk Mode", vm.TalkModeLabel);
    }

    [Fact]
    public void TalkModeLabel_Active_ShowsStop()
    {
        var vm = MakeVm();
        vm.TalkEnabled = true;
        Assert.Equal("Stop Talk Mode", vm.TalkModeLabel);
    }

    // ── OpenCanvasLabel ───────────────────────────────────────────────────────

    [Fact]
    public void OpenCanvasLabel_Hidden_ShowsOpen()
    {
        var vm = MakeVm();
        vm.IsCanvasPanelVisible = false;
        Assert.Equal("Open Canvas", vm.OpenCanvasLabel);
    }

    [Fact]
    public void OpenCanvasLabel_Visible_ShowsClose()
    {
        var vm = MakeVm();
        vm.IsCanvasPanelVisible = true;
        Assert.Equal("Close Canvas", vm.OpenCanvasLabel);
    }

    // ── IsActive ──────────────────────────────────────────────────────────────

    [Fact]
    public void IsActive_WhenNotPaused_IsTrue()
    {
        var vm = MakeVm();
        vm.IsPaused = false;
        Assert.True(vm.IsActive);
    }

    [Fact]
    public void IsActive_WhenPaused_IsFalse()
    {
        var vm = MakeVm();
        vm.IsPaused = true;
        Assert.False(vm.IsActive);
    }

    // ── PairingStatusText (mirrors pairingPrompter label in MenuContentView.swift) ──

    [Fact]
    public void PairingStatusText_NoPending_ShowsZeroCount()
    {
        Assert.Contains("(0)", MakeVm().PairingStatusText);
    }

    [Fact]
    public void PairingStatusText_WithPending_ShowsCount()
    {
        var vm = MakeVm();
        vm.PairingPendingCount = 3;
        Assert.Contains("(3)", vm.PairingStatusText);
    }

    [Fact]
    public void PairingStatusText_WithRepair_AppendsRepairSuffix()
    {
        var vm = MakeVm();
        vm.PairingPendingCount      = 2;
        vm.PairingPendingRepairCount = 1;
        Assert.Contains("· 1 repair", vm.PairingStatusText);
    }

    [Fact]
    public void PairingStatusText_NoRepair_NoRepairSuffix()
    {
        var vm = MakeVm();
        vm.PairingPendingCount      = 1;
        vm.PairingPendingRepairCount = 0;
        Assert.DoesNotContain("repair", vm.PairingStatusText);
    }

    // ── DevicePairingStatusText ───────────────────────────────────────────────

    [Fact]
    public void DevicePairingStatusText_WithPendingAndRepair_ShowsBoth()
    {
        var vm = MakeVm();
        vm.DevicePairingPendingCount       = 4;
        vm.DevicePairingPendingRepairCount = 2;
        var text = vm.DevicePairingStatusText;
        Assert.Contains("(4)", text);
        Assert.Contains("· 2 repair", text);
    }

    // ── MicPickerLabel (mirrors voiceWakeMicMenu title in MenuContentView.swift) ──

    [Fact]
    public void MicPickerLabel_Default_ShowsSystemDefault()
    {
        Assert.Equal("Microphone: System default", MakeVm().MicPickerLabel);
    }

    [Fact]
    public void MicPickerLabel_AfterMicSelected_ReflectsSelection()
    {
        var vm = MakeVm();
        vm.SelectedMicLabel = "Built-in Mic";
        Assert.Equal("Microphone: Built-in Mic", vm.MicPickerLabel);
    }

    // ── ShowMicPicker ─────────────────────────────────────────────────────────

    [Fact]
    public void ShowMicPicker_VoiceWakeNotSupported_IsFalse()
    {
        // SPIKE-004: IsVoiceWakeSupported = false always on Windows currently.
        Assert.False(MakeVm().ShowMicPicker);
    }

    // ── HeartbeatStatus initial state ─────────────────────────────────────────

    [Fact]
    public void HeartbeatStatusLabel_Initial_IsNoHeartbeatYet()
    {
        Assert.Equal("No heartbeat yet", MakeVm().HeartbeatStatusLabel);
    }

    [Fact]
    public void HeartbeatStatusColor_Initial_IsGray()
    {
        Assert.Equal("gray", MakeVm().HeartbeatStatusColor);
    }

    // ── Factory ───────────────────────────────────────────────────────────────

    private static SystemTrayViewModel MakeVm()
    {
        var sender          = Substitute.For<ISender>();
        var sp              = Substitute.For<IServiceProvider>();
        var updater         = Substitute.For<IUpdaterController>();
        var healthStore     = Substitute.For<IHealthStore>();
        var activityStore   = Substitute.For<IWorkActivityStore>();
        var chatManager     = Substitute.For<IWebChatManager>();
        var rpc             = Substitute.For<IGatewayRpcChannel>();
        var gatewayPm       = Substitute.For<IGatewayProcessManager>();
        var heartbeatStore  = Substitute.For<IHeartbeatStore>();
        var nodePairing     = Substitute.For<INodePairingPendingMonitor>();
        var devicePairing   = Substitute.For<IDevicePairingPendingMonitor>();
        var nodesStore      = Substitute.For<INodesStore>();
        var voiceForwarder  = Substitute.For<IVoiceWakeForwarder>();
        var notifProvider   = Substitute.For<INotificationProvider>();

        // UpdateStatus must not be null — ViewModel subscribes to PropertyChanged in ctor.
        updater.UpdateStatus.Returns(UpdateStatus.Disabled);
        nodesStore.Nodes.Returns(Array.Empty<NodeInfo>());

        var injector        = new MenuSessionsInjector(sender, rpc);
        var contextInjector = new MenuContextCardInjector(sender);

        // DispatcherQueue cannot be constructed outside the WinRT COM host.
        // Pass null! — the ctor only stores it; no TryEnqueue calls during construction.
        return new SystemTrayViewModel(
            sender, sp, updater, healthStore, activityStore,
            chatManager, rpc, gatewayPm,
            null!,   // DispatcherQueue — safe: not called during construction
            injector,
            contextInjector,
            heartbeatStore, nodePairing, devicePairing, nodesStore,
            voiceForwarder, notifProvider,
            new Serilog.Core.LoggingLevelSwitch());
    }
}
