using MediatR;
using NSubstitute;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Tests.Unit.Presentation;

public sealed class VoiceOverlayViewModelTests
{
    private static VoiceOverlayViewModel Make() =>
        new(Substitute.For<ISender>());

    // ── CommittedText / VolatileText ──────────────────────────────────────────
    // Adapts Swift model.attributed: committed = confirmed text, volatile = in-progress text.

    [Fact]
    public void CommittedText_IsEmpty_WhenPartial()
    {
        var vm = Make();
        vm.UpdatePartial("hello");
        Assert.Equal(string.Empty, vm.CommittedText);
    }

    [Fact]
    public void VolatileText_IsTranscript_WhenPartial()
    {
        var vm = Make();
        vm.UpdatePartial("hello");
        Assert.Equal("hello", vm.VolatileText);
    }

    [Fact]
    public void CommittedText_IsTranscript_WhenFinal()
    {
        var vm = Make();
        vm.PresentFinal("hello world");
        Assert.Equal("hello world", vm.CommittedText);
    }

    [Fact]
    public void VolatileText_IsEmpty_WhenFinal()
    {
        var vm = Make();
        vm.PresentFinal("hello world");
        Assert.Equal(string.Empty, vm.VolatileText);
    }

    [Fact]
    public void CommittedText_IsTranscript_WhenEditing()
    {
        // While editing, text counts as committed (user has taken ownership).
        var vm = Make();
        vm.PresentFinal("hello");
        vm.UserBeganEditing();
        Assert.Equal("hello", vm.CommittedText);
    }

    [Fact]
    public void VolatileText_IsEmpty_WhenEditing()
    {
        var vm = Make();
        vm.PresentFinal("hello");
        vm.UserBeganEditing();
        Assert.Equal(string.Empty, vm.VolatileText);
    }

    [Fact]
    public void CommittedAndVolatile_BothEmpty_OnDismiss()
    {
        var vm = Make();
        vm.PresentFinal("done");
        vm.DismissCommand.Execute(null);
        Assert.Equal(string.Empty, vm.CommittedText);
        Assert.Equal(string.Empty, vm.VolatileText);
    }

    // ── MicLevelBarWidth ──────────────────────────────────────────────────────

    [Fact]
    public void MicLevelBarWidth_ClampsToSendButtonWidth()
    {
        var vm = Make();
        vm.UpdateMicLevel(2.0); // over 1.0
        Assert.Equal(32.0, vm.MicLevelBarWidth); // SendButtonWidth = 32
    }

    [Fact]
    public void MicLevelBarWidth_Zero_WhenLevelZero()
    {
        var vm = Make();
        vm.UpdateMicLevel(0.0);
        Assert.Equal(0.0, vm.MicLevelBarWidth);
    }

    [Fact]
    public void MicLevelBarWidth_Half_WhenLevel05()
    {
        var vm = Make();
        vm.UpdateMicLevel(0.5);
        Assert.Equal(16.0, vm.MicLevelBarWidth);
    }
}
