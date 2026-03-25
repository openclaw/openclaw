using Microsoft.Extensions.Logging.Abstractions;
using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Tests.Unit.Application.VoiceWake;

public sealed class VoiceSessionCoordinatorTests
{
    private readonly IVoiceOverlayBridge     _overlay   = Substitute.For<IVoiceOverlayBridge>();
    private readonly IVoiceWakeForwarder     _forwarder = Substitute.For<IVoiceWakeForwarder>();
    private readonly VoiceSessionCoordinator _sut;

    public VoiceSessionCoordinatorTests()
    {
        _forwarder
            .ForwardAsync(Arg.Any<string>(), Arg.Any<ForwardOptions?>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<(bool Ok, string? Error)>((true, null)));

        _sut = new VoiceSessionCoordinator(
            _overlay, _forwarder,
            NullLogger<VoiceSessionCoordinator>.Instance);
    }

    // ── StartSession ──────────────────────────────────────────────────────────

    [Fact]
    public void StartSession_ReturnsNonEmptyToken()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        Assert.NotEqual(Guid.Empty, token);
    }

    [Fact]
    public void StartSession_CallsOverlayStartSession()
    {
        var token = _sut.StartSession(VoiceSessionSource.PushToTalk, "test", forwardEnabled: true);
        _overlay.Received(1).StartSession(token, VoiceSessionSource.PushToTalk, "test", true, false);
    }

    [Fact]
    public void StartSession_SnapshotReflectsNewSession()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello world");
        var (snapToken, snapText, _) = _sut.Snapshot();
        Assert.Equal(token, snapToken);
        Assert.Equal("hello world", snapText);
    }

    // ── UpdatePartial ─────────────────────────────────────────────────────────

    [Fact]
    public void UpdatePartial_WrongToken_IsDropped()
    {
        _sut.StartSession(VoiceSessionSource.WakeWord, "initial");
        _sut.UpdatePartial(Guid.NewGuid(), "updated");
        _overlay.DidNotReceive().UpdatePartial(Arg.Any<Guid>(), Arg.Any<string>());
    }

    [Fact]
    public void UpdatePartial_CorrectToken_CallsOverlay()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "initial");
        _sut.UpdatePartial(token, "updated text");
        _overlay.Received(1).UpdatePartial(token, "updated text");
    }

    [Fact]
    public void UpdatePartial_CorrectToken_UpdatesSnapshot()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "initial");
        _sut.UpdatePartial(token, "updated text");
        Assert.Equal("updated text", _sut.Snapshot().Text);
    }

    // ── Finalize ──────────────────────────────────────────────────────────────

    [Fact]
    public void Finalize_WrongToken_IsDropped()
    {
        _sut.StartSession(VoiceSessionSource.WakeWord, "initial");
        _sut.Finalize(Guid.NewGuid(), "final", new VoiceWakeChime.None(), null);
        _overlay.DidNotReceive().PresentFinal(
            Arg.Any<Guid>(), Arg.Any<string>(), Arg.Any<double?>(), Arg.Any<VoiceWakeChime>());
    }

    [Fact]
    public void Finalize_CorrectToken_CallsOverlayPresentFinal()
    {
        var token  = _sut.StartSession(VoiceSessionSource.WakeWord, "initial");
        var chime  = new VoiceWakeChime.None();
        _sut.Finalize(token, "final text", chime, 2.0);
        _overlay.Received(1).PresentFinal(token, "final text", 2.0, chime);
    }

    // ── SendNow ───────────────────────────────────────────────────────────────

    [Fact]
    public void SendNow_WrongToken_IsDropped()
    {
        _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.SendNow(Guid.NewGuid());
        _overlay.DidNotReceive().BeginSendUI(Arg.Any<Guid>(), Arg.Any<VoiceWakeChime>());
        _overlay.DidNotReceive().Dismiss(Arg.Any<Guid>(), Arg.Any<VoiceDismissReason>(), Arg.Any<VoiceSendOutcome>());
    }

    [Fact]
    public void SendNow_EmptyText_DismissesWithEmpty()
    {
        // Whitespace-only text trims to empty → dismiss path
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "   ");
        _sut.SendNow(token);
        _overlay.Received(1).Dismiss(token, VoiceDismissReason.Empty, VoiceSendOutcome.Empty);
        _overlay.DidNotReceive().BeginSendUI(Arg.Any<Guid>(), Arg.Any<VoiceWakeChime>());
    }

    [Fact]
    public void SendNow_NonEmptyText_CallsBeginSendUI()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "do the thing");
        _sut.SendNow(token);
        // BeginSendUI is called synchronously before the fire-and-forget forward
        _overlay.Received(1).BeginSendUI(token, Arg.Any<VoiceWakeChime>());
    }

    // ── Dismiss ───────────────────────────────────────────────────────────────

    [Fact]
    public void Dismiss_WrongToken_IsDropped()
    {
        _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.Dismiss(Guid.NewGuid(), VoiceDismissReason.Explicit, VoiceSendOutcome.Empty);
        _overlay.DidNotReceive().Dismiss(
            Arg.Any<Guid>(), Arg.Any<VoiceDismissReason>(), Arg.Any<VoiceSendOutcome>());
    }

    [Fact]
    public void Dismiss_CorrectToken_CallsOverlayAndClearsSession()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.Dismiss(token, VoiceDismissReason.Explicit, VoiceSendOutcome.Sent);
        _overlay.Received(1).Dismiss(token, VoiceDismissReason.Explicit, VoiceSendOutcome.Sent);
        Assert.Null(_sut.Snapshot().Token);
    }

    // ── UpdateLevel ───────────────────────────────────────────────────────────

    [Fact]
    public void UpdateLevel_WrongToken_IsDropped()
    {
        _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.UpdateLevel(Guid.NewGuid(), 0.5);
        _overlay.DidNotReceive().UpdateLevel(Arg.Any<Guid>(), Arg.Any<double>());
    }

    [Fact]
    public void UpdateLevel_CorrectToken_CallsOverlay()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.UpdateLevel(token, 0.75);
        _overlay.Received(1).UpdateLevel(token, 0.75);
    }

    // ── Snapshot ──────────────────────────────────────────────────────────────

    [Fact]
    public void Snapshot_NoSession_ReturnsEmptySnapshot()
    {
        var (token, text, _) = _sut.Snapshot();
        Assert.Null(token);
        Assert.Equal(string.Empty, text);
    }

    [Fact]
    public void Snapshot_VisibleDelegatesToOverlay()
    {
        _overlay.IsVisible.Returns(true);
        Assert.True(_sut.Snapshot().Visible);
    }

    // ── OverlayDidDismiss ─────────────────────────────────────────────────────

    [Fact]
    public void OverlayDidDismiss_MatchingToken_ClearsSession()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.OverlayDidDismiss(token);
        Assert.Null(_sut.Snapshot().Token);
    }

    [Fact]
    public void OverlayDidDismiss_MismatchToken_PreservesSession()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.OverlayDidDismiss(Guid.NewGuid());
        Assert.Equal(token, _sut.Snapshot().Token);
    }

    [Fact]
    public void OverlayDidDismiss_NullToken_PreservesSession()
    {
        var token = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        _sut.OverlayDidDismiss(null);
        Assert.Equal(token, _sut.Snapshot().Token);
    }

    [Fact]
    public void OverlayDidDismiss_FiresSessionDismissedEvent()
    {
        // Mirrors Swift: Task { await VoiceWakeRuntime.shared.refresh(state: AppStateStore.shared) }
        var token      = _sut.StartSession(VoiceSessionSource.WakeWord, "hello");
        Guid? received = Guid.Empty;
        _sut.SessionDismissed += t => received = t;

        _sut.OverlayDidDismiss(token);

        Assert.Equal(token, received);
    }
}
