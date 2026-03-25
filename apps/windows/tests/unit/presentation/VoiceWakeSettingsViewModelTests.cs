using MediatR;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Tests.Unit.Presentation;

// Mirrors VoiceWakeSettings.swift test state extension — headless (no WinRT) tests.
public sealed class VoiceWakeSettingsViewModelTests
{
    private static VoiceWakeSettingsViewModel MakeVm(IVoiceWakeTesterService? tester = null)
        => new(Substitute.For<ISender>(), tester);

    // ── Initial state ─────────────────────────────────────────────────────────

    [Fact]
    public void TestState_InitiallyIdle()
    {
        var vm = MakeVm();
        Assert.IsType<VoiceWakeTestState.Idle>(vm.TestState);
    }

    [Fact]
    public void IsTesting_InitiallyFalse()
    {
        var vm = MakeVm();
        Assert.False(vm.IsTesting);
    }

    [Fact]
    public void ToggleTestCommand_IsNotNull()
    {
        var vm = MakeVm();
        Assert.NotNull(vm.ToggleTestCommand);
    }

    // ── No tester registered ──────────────────────────────────────────────────

    [Fact]
    public async Task ToggleTest_NullTester_SetsFailed()
    {
        var vm = MakeVm(tester: null);
        await vm.ToggleTestCommand.ExecuteAsync(null);
        Assert.IsType<VoiceWakeTestState.Failed>(vm.TestState);
    }

    // ── Toggle with mock tester ───────────────────────────────────────────────

    [Fact]
    public async Task ToggleTest_WhenNotTesting_SetsIsTestingTrue()
    {
        var tester = Substitute.For<IVoiceWakeTesterService>();
        // StartAsync returns immediately without calling onUpdate (simulates no speech)
        tester.StartAsync(
            Arg.Any<IEnumerable<string>>(), Arg.Any<string?>(), Arg.Any<string?>(),
            Arg.Any<Action<VoiceWakeTestState>>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);

        var vm = MakeVm(tester);
        await vm.ToggleTestCommand.ExecuteAsync(null);

        Assert.True(vm.IsTesting);
    }

    [Fact]
    public async Task ToggleTest_OnUpdate_Detected_SetsIsTestingFalse()
    {
        var tester = Substitute.For<IVoiceWakeTesterService>();
        tester.StartAsync(
            Arg.Any<IEnumerable<string>>(), Arg.Any<string?>(), Arg.Any<string?>(),
            Arg.Any<Action<VoiceWakeTestState>>(), Arg.Any<CancellationToken>())
            .Returns(callInfo =>
            {
                // Synchronously fire the onUpdate callback (headless: no queue dispatch)
                var cb = callInfo.ArgAt<Action<VoiceWakeTestState>>(3);
                cb(new VoiceWakeTestState.Detected("ok"));
                return Task.CompletedTask;
            });

        var vm = MakeVm(tester);
        await vm.ToggleTestCommand.ExecuteAsync(null);

        Assert.IsType<VoiceWakeTestState.Detected>(vm.TestState);
        Assert.False(vm.IsTesting);
    }

    // ── StopTest ──────────────────────────────────────────────────────────────

    [Fact]
    public void StopTest_ResetsToIdle()
    {
        var tester = Substitute.For<IVoiceWakeTesterService>();
        var vm     = MakeVm(tester);
        vm.IsTesting = true;
        vm.TestState  = new VoiceWakeTestState.Listening();

        vm.StopTest();

        Assert.False(vm.IsTesting);
        Assert.IsType<VoiceWakeTestState.Idle>(vm.TestState);
        tester.Received(1).Stop();
    }
}
