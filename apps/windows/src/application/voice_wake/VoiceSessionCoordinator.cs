using Microsoft.Extensions.Logging;
using OpenClawWindows.Domain.VoiceWake;

namespace OpenClawWindows.Application.VoiceWake;

/// <summary>
/// Orchestrates the voice session lifecycle: start, partial updates, finalize, dismiss, auto-send.
/// Handles both wake-word and push-to-talk sources.
/// VoiceWakeOverlayController.shared calls → IVoiceOverlayBridge (Presentation layer implements it).
/// VoiceWakeRuntime.shared.refresh(state:) → SessionDismissed event (infra subscribes to resume recognizer).
/// </summary>
internal sealed class VoiceSessionCoordinator : IVoiceSessionNotifier
{
    private readonly IVoiceOverlayBridge              _overlay;
    private readonly IVoiceWakeForwarder              _forwarder;
    private readonly ILogger<VoiceSessionCoordinator> _logger;

    // All mutations lock-protected — adapts @MainActor isolation to thread-safe instance.
    private readonly Lock     _lock    = new();
    private          Session? _session;

    // Infra layer subscribes to resume the wake-word recognizer after the overlay is dismissed.
    internal event Action<Guid?>? SessionDismissed;

    public VoiceSessionCoordinator(
        IVoiceOverlayBridge              overlay,
        IVoiceWakeForwarder              forwarder,
        ILogger<VoiceSessionCoordinator> logger)
    {
        _overlay   = overlay;
        _forwarder = forwarder;
        _logger    = logger;
    }

    // attributed: NSAttributedString → omitted; overlay formats its own attributed text on Windows.
    internal Guid StartSession(
        VoiceSessionSource source,
        string             text,
        bool               forwardEnabled = false)
    {
        var token = Guid.NewGuid();
        _logger.LogInformation(
            "coordinator start token={Token} source={Source} len={Len}",
            token, source, text.Length);
        lock (_lock)
        {
            _session = new Session(token, source, text, IsFinal: false, new VoiceWakeChime.None(), AutoSendDelay: null);
        }
        _overlay.StartSession(token, source, text, forwardEnabled, isFinal: false);
        return token;
    }

    internal void UpdatePartial(Guid token, string text)
    {
        lock (_lock)
        {
            if (_session?.Token != token) return;
            _session = _session with { Text = text };
        }
        _overlay.UpdatePartial(token, text);
    }

    internal void Finalize(Guid token, string text, VoiceWakeChime sendChime, double? autoSendAfter)
    {
        lock (_lock)
        {
            if (_session?.Token != token) return;
            _session = _session with { Text = text, IsFinal = true, SendChime = sendChime, AutoSendDelay = autoSendAfter };
        }
        _logger.LogInformation(
            "coordinator finalize token={Token} len={Len} autoSendAfter={Delay}",
            token, text.Length, autoSendAfter ?? -1);
        _overlay.PresentFinal(token, text, autoSendAfter, sendChime);
    }

    public void SendNow(Guid token, string reason = "explicit")
    {
        Session? session;
        lock (_lock)
        {
            if (_session?.Token != token) return;
            session = _session;
        }

        var text = session.Text.Trim();
        if (string.IsNullOrEmpty(text))
        {
            _logger.LogInformation("coordinator sendNow {Reason} empty -> dismiss", reason);
            _overlay.Dismiss(token, VoiceDismissReason.Empty, VoiceSendOutcome.Empty);
            lock (_lock) { if (_session?.Token == token) _session = null; }
            return;
        }

        _overlay.BeginSendUI(token, session.SendChime);
        _ = Task.Run(() => _forwarder.ForwardAsync(text));
    }

    internal void Dismiss(Guid token, VoiceDismissReason reason, VoiceSendOutcome outcome)
    {
        lock (_lock)
        {
            if (_session?.Token != token) return;
            _session = null;
        }
        _overlay.Dismiss(token, reason, outcome);
    }

    internal void UpdateLevel(Guid token, double level)
    {
        lock (_lock) { if (_session?.Token != token) return; }
        _overlay.UpdateLevel(token, level);
    }

    internal (Guid? Token, string Text, bool Visible) Snapshot()
    {
        Session? s;
        lock (_lock) { s = _session; }
        return (s?.Token, s?.Text ?? string.Empty, _overlay.IsVisible);
    }

    // Called by the overlay controller after the dismiss animation completes.
    public void OverlayDidDismiss(Guid? token)
    {
        lock (_lock)
        {
            if (token.HasValue && _session?.Token == token)
                _session = null;
        }
        SessionDismissed?.Invoke(token);
    }

    private sealed record Session(
        Guid               Token,
        VoiceSessionSource Source,
        string             Text,
        bool               IsFinal,
        VoiceWakeChime     SendChime,
        double?            AutoSendDelay);
}
