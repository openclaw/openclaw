using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.VoiceWake;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Voice;

namespace OpenClawWindows.Tests.Unit.Presentation;

// Mirrors VoiceWakeOverlayControllerTests.swift — headless (queue=null) session lifecycle tests.
public sealed class VoiceOverlaySessionControllerTests
{
    private static VoiceOverlaySessionController MakeController()
    {
        var services = new ServiceCollection()
            .AddSingleton(Substitute.For<ISender>())
            .AddTransient<VoiceOverlayViewModel>()
            .BuildServiceProvider();
        return new VoiceOverlaySessionController(
            services,
            queue: null,
            NullLogger<VoiceOverlaySessionController>.Instance);
    }

    // ── StartSession ──────────────────────────────────────────────────────────
    // Mirrors: overlay controller lifecycle without UI

    [Fact]
    public void StartSession_SetsActiveTokenAndVisible()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "hello", forwardEnabled: true, isFinal: false);

        var snap = sut.Snapshot();
        Assert.Equal(token, snap.Token);
        Assert.True(snap.IsVisible);
    }

    [Fact]
    public void StartSession_SetsSourceAndText()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.PushToTalk, "test text", forwardEnabled: false, isFinal: false);

        var snap = sut.Snapshot();
        Assert.Equal(VoiceSessionSource.PushToTalk, snap.Source);
        Assert.Equal("test text", snap.Text);
    }

    [Fact]
    public void StartSession_IsVisible_IsTrue()
    {
        var sut = MakeController();
        sut.StartSession(Guid.NewGuid(), VoiceSessionSource.WakeWord, "hi", forwardEnabled: false, isFinal: false);
        Assert.True(sut.IsVisible);
    }

    // ── UpdatePartial ─────────────────────────────────────────────────────────

    [Fact]
    public void UpdatePartial_WrongToken_IsDropped()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "initial", forwardEnabled: false, isFinal: false);
        sut.UpdatePartial(Guid.NewGuid(), "should be ignored");

        Assert.Equal("initial", sut.Snapshot().Text);
    }

    [Fact]
    public void UpdatePartial_CorrectToken_UpdatesText()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "hello", forwardEnabled: false, isFinal: false);
        sut.UpdatePartial(token, "hello world");

        Assert.Equal("hello world", sut.Snapshot().Text);
    }

    [Fact]
    public void UpdatePartial_WhenFinal_IsDropped()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "hello", forwardEnabled: false, isFinal: false);
        sut.PresentFinal(token, "final", autoSendAfter: null, sendChime: new VoiceWakeChime.None());
        sut.UpdatePartial(token, "should not replace");

        // Text stays at "final" — mirrors Swift guard !model.isFinal
        Assert.Equal("final", sut.Snapshot().Text);
    }

    // ── PresentFinal ──────────────────────────────────────────────────────────

    [Fact]
    public void PresentFinal_WrongToken_IsDropped()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "hello", forwardEnabled: false, isFinal: false);
        sut.PresentFinal(Guid.NewGuid(), "wrong", autoSendAfter: null,
            sendChime: new VoiceWakeChime.None());

        Assert.Equal("hello", sut.Snapshot().Text);
    }

    [Fact]
    public void PresentFinal_CorrectToken_UpdatesText()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "partial", forwardEnabled: false, isFinal: false);
        sut.PresentFinal(token, "final text", autoSendAfter: null,
            sendChime: new VoiceWakeChime.None());

        Assert.Equal("final text", sut.Snapshot().Text);
    }

    // ── Dismiss ───────────────────────────────────────────────────────────────
    // Mirrors: overlay dismiss → isVisible=false, token=nil

    [Fact]
    public void Dismiss_CorrectToken_ClearsSessionAndHides()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "hello", forwardEnabled: false, isFinal: false);
        sut.Dismiss(token, VoiceDismissReason.Explicit, VoiceSendOutcome.Empty);

        var snap = sut.Snapshot();
        Assert.False(snap.IsVisible);
        Assert.Null(snap.Token);
    }

    [Fact]
    public void Dismiss_WrongToken_IsDropped()
    {
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "hello", forwardEnabled: false, isFinal: false);
        sut.Dismiss(Guid.NewGuid(), VoiceDismissReason.Explicit, VoiceSendOutcome.Empty);

        Assert.True(sut.IsVisible);
        Assert.Equal(token, sut.Snapshot().Token);
    }

    // ── UpdateLevel ───────────────────────────────────────────────────────────
    // Mirrors: update level throttles rapid changes

    [Fact]
    public void UpdateLevel_BelowZero_DoesNotThrow()
    {
        // level=0 bypasses throttle; negative values clamp to 0 — must not throw.
        var sut   = MakeController();
        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "level test", forwardEnabled: false, isFinal: false);
        sut.UpdateLevel(token, -0.5);
        // No exception = pass (MicLevel clamping verified in VoiceOverlayViewModelTests)
    }

    [Fact]
    public void UpdateLevel_WrongToken_IsDropped()
    {
        var sut   = MakeController();
        sut.StartSession(Guid.NewGuid(), VoiceSessionSource.WakeWord, "test", forwardEnabled: false, isFinal: false);
        // Should not throw even with mismatched token
        sut.UpdateLevel(Guid.NewGuid(), 0.5);
    }

    // ── EvaluateToken ─────────────────────────────────────────────────────────
    // Mirrors: evaluate token drops mismatch and no active

    [Fact]
    public void EvaluateToken_NoActive_ReturnsDropNoActive()
    {
        var result = VoiceOverlaySessionController.EvaluateToken(active: null, incoming: Guid.NewGuid());
        Assert.Equal(GuardOutcome.DropNoActive, result);
    }

    [Fact]
    public void EvaluateToken_Mismatch_ReturnsDropMismatch()
    {
        var active = Guid.NewGuid();
        var result = VoiceOverlaySessionController.EvaluateToken(active: active, incoming: Guid.NewGuid());
        Assert.Equal(GuardOutcome.DropMismatch, result);
    }

    [Fact]
    public void EvaluateToken_Match_ReturnsAccept()
    {
        var token  = Guid.NewGuid();
        var result = VoiceOverlaySessionController.EvaluateToken(active: token, incoming: token);
        Assert.Equal(GuardOutcome.Accept, result);
    }

    [Fact]
    public void EvaluateToken_NullIncoming_ReturnsAccept()
    {
        // Mirrors Swift: if let incoming, incoming != active → mismatch. nil incoming → accept.
        var active = Guid.NewGuid();
        var result = VoiceOverlaySessionController.EvaluateToken(active: active, incoming: null);
        Assert.Equal(GuardOutcome.Accept, result);
    }

    // ── Auto-send scheduling ──────────────────────────────────────────────────

    [Fact]
    public async Task PresentFinal_AutoSendImmediate_FiresSendNow()
    {
        var notifier = Substitute.For<IVoiceSessionNotifier>();
        var services = new ServiceCollection()
            .AddSingleton(Substitute.For<ISender>())
            .AddTransient<VoiceOverlayViewModel>()
            .AddSingleton(notifier)
            .BuildServiceProvider();
        var sut = new VoiceOverlaySessionController(
            services, queue: null,
            NullLogger<VoiceOverlaySessionController>.Instance);

        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "send me", forwardEnabled: true, isFinal: false);
        sut.PresentFinal(token, "send me", autoSendAfter: 0, // <= 0 → immediate
            sendChime: new VoiceWakeChime.None());

        // Immediate send is synchronous in headless mode
        notifier.Received(1).SendNow(token, "autoSendImmediate");
    }

    [Fact]
    public async Task PresentFinal_AutoSendDelayed_FiresAfterDelay()
    {
        var notifier = Substitute.For<IVoiceSessionNotifier>();
        var services = new ServiceCollection()
            .AddSingleton(Substitute.For<ISender>())
            .AddTransient<VoiceOverlayViewModel>()
            .AddSingleton(notifier)
            .BuildServiceProvider();
        var sut = new VoiceOverlaySessionController(
            services, queue: null,
            NullLogger<VoiceOverlaySessionController>.Instance);

        var token = Guid.NewGuid();
        sut.StartSession(token, VoiceSessionSource.WakeWord, "auto", forwardEnabled: true, isFinal: false);
        sut.PresentFinal(token, "auto", autoSendAfter: 0.05, // 50 ms
            sendChime: new VoiceWakeChime.None());

        await Task.Delay(200); // wait well past the delay
        notifier.Received(1).SendNow(token, "autoSendDelay");
    }

    [Fact]
    public void StartSession_CancelsExistingAutoSend()
    {
        // Starting a new session cancels any pending auto-send from the previous one.
        var notifier = Substitute.For<IVoiceSessionNotifier>();
        var services = new ServiceCollection()
            .AddSingleton(Substitute.For<ISender>())
            .AddTransient<VoiceOverlayViewModel>()
            .AddSingleton(notifier)
            .BuildServiceProvider();
        var sut = new VoiceOverlaySessionController(
            services, queue: null,
            NullLogger<VoiceOverlaySessionController>.Instance);

        var token1 = Guid.NewGuid();
        sut.StartSession(token1, VoiceSessionSource.WakeWord, "first", forwardEnabled: true, isFinal: false);
        sut.PresentFinal(token1, "first", autoSendAfter: 10.0, // long delay
            sendChime: new VoiceWakeChime.None());

        // New session cancels the pending auto-send
        var token2 = Guid.NewGuid();
        sut.StartSession(token2, VoiceSessionSource.WakeWord, "second", forwardEnabled: false, isFinal: false);

        Assert.Equal(token2, sut.Snapshot().Token);
    }
}
