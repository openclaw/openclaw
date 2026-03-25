using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.VoiceWake;
using OpenClawWindows.Presentation.ViewModels;

namespace OpenClawWindows.Presentation.Voice;

internal enum GuardOutcome { Accept, DropMismatch, DropNoActive }

/// <summary>
/// Manages voice overlay session lifecycle: token guards, partial updates, final presentation,
/// auto-send scheduling, and dismiss. Implements IVoiceOverlayBridge so VoiceSessionCoordinator
/// can drive the overlay without depending on Presentation types.
/// IVoiceSessionNotifier and IVoiceWakeChimePlayer are resolved lazily via IServiceProvider to
/// break the circular dependency with VoiceSessionCoordinator.
/// </summary>
internal sealed class VoiceOverlaySessionController : IVoiceOverlayBridge
{
    private readonly IServiceProvider                         _services;
    private readonly DispatcherQueue?                         _queue;
    private readonly ILogger<VoiceOverlaySessionController>  _logger;
    private readonly VoiceOverlayWindowController            _windowController;

    // Session state — only mutated on UI thread (inside Dispatch).
    private Guid?               _activeToken;
    private VoiceSessionSource? _activeSource;
    private Guid?               _autoSendToken;
    private CancellationTokenSource? _autoSendCts;
    private long                _lastLevelUpdateMs;

    // ViewModel — only accessed on UI thread.
    private VoiceOverlayViewModel? _vm;

    // Tunables
    private const int LevelThrottleMs   = 83;
    private const int BeginSendDelayMs  = 280;

    public bool IsVisible => _windowController.IsVisible;

    internal VoiceOverlaySessionController(
        IServiceProvider                        services,
        DispatcherQueue?                        queue,
        ILogger<VoiceOverlaySessionController>  logger)
    {
        _services = services;
        _queue    = queue;
        _logger   = logger;
        var winLogger = services.GetService<ILogger<VoiceOverlayWindowController>>()
                        ?? NullLogger<VoiceOverlayWindowController>.Instance;
        _windowController = new VoiceOverlayWindowController(queue, winLogger);
    }

    // ── IVoiceOverlayBridge ──────────────────────────────────────────────────

    public void StartSession(
        Guid               token,
        VoiceSessionSource source,
        string             transcript,
        bool               forwardEnabled,
        bool               isFinal)
    {
        Dispatch(() =>
        {
            _logger.LogInformation(
                "overlay session_start source={Source} len={Len}", source, transcript.Length);
            _activeToken  = token;
            _activeSource = source;
            CancelAutoSend();
            EnsureVm();
            _vm!.UpdatePartial(transcript);
            _vm.IsFinal        = isFinal;
            _vm.ForwardEnabled = forwardEnabled;
            _vm.IsSending      = false;
            _vm.IsEditing      = false;
            _vm.MicLevel       = 0;
            Present();
        });
    }

    public void UpdatePartial(Guid token, string transcript)
    {
        Dispatch(() =>
        {
            if (!GuardToken(token, "partial")) return;
            if (_vm?.IsFinal == true) return;
            _logger.LogInformation(
                "overlay partial token={Token} len={Len}", token, transcript.Length);
            CancelAutoSend();
            EnsureVm();
            _vm!.UpdatePartial(transcript);
            _vm.ForwardEnabled = false;
            Present();
        });
    }

    public void PresentFinal(
        Guid           token,
        string         transcript,
        double?        autoSendAfter,
        VoiceWakeChime sendChime)
    {
        Dispatch(() =>
        {
            if (!GuardToken(token, "final")) return;
            _logger.LogInformation(
                "overlay presentFinal token={Token} len={Len} autoSendAfter={Delay} forwardEnabled={Fwd}",
                token, transcript.Length, autoSendAfter ?? -1,
                !string.IsNullOrWhiteSpace(transcript));
            _autoSendCts?.Cancel();
            _autoSendToken = token;
            EnsureVm();
            _vm!.TranscriptText = transcript;
            _vm.IsFinal         = true;
            _vm.ForwardEnabled  = !string.IsNullOrWhiteSpace(transcript);
            _vm.IsSending       = false;
            _vm.IsEditing       = false;
            _vm.MicLevel        = 0;
            Present();
            if (autoSendAfter is { } delay)
            {
                if (delay <= 0)
                {
                    _logger.LogInformation("overlay autoSend immediate token={Token}", token);
                    GetNotifier()?.SendNow(token, "autoSendImmediate");
                }
                else
                {
                    ScheduleAutoSend(token, delay);
                }
            }
        });
    }

    public void BeginSendUI(Guid token, VoiceWakeChime sendChime)
    {
        Dispatch(() =>
        {
            if (!GuardToken(token, "beginSendUI")) return;
            CancelAutoSend();
            _logger.LogInformation(
                "overlay beginSendUI token={Token} isSending={Sending} forwardEnabled={Fwd} textLen={Len}",
                token, _vm?.IsSending, _vm?.ForwardEnabled, _vm?.TranscriptText.Length ?? 0);
            if (_vm?.IsSending == true) return;
            if (_vm != null) _vm.IsEditing = false;
            if (sendChime is not VoiceWakeChime.None)
            {
                _logger.LogInformation(
                    "overlay beginSendUI playing sendChime={Chime}", sendChime);
                _services.GetService<IVoiceWakeChimePlayer>()?.Play(sendChime, "overlay.send");
            }
            if (_vm != null) _vm.IsSending = true;
            var capturedToken = token;
            _ = Task.Run(async () =>
            {
                await Task.Delay(BeginSendDelayMs);
                Dispatch(() =>
                {
                    _logger.LogInformation(
                        "overlay beginSendUI dismiss ticking token={Active}", _activeToken);
                    DismissCore(capturedToken, VoiceDismissReason.Explicit, VoiceSendOutcome.Sent);
                });
            });
        });
    }

    public void Dismiss(Guid token, VoiceDismissReason reason, VoiceSendOutcome outcome)
        => Dispatch(() => DismissCore(token, reason, outcome));

    public void UpdateLevel(Guid token, double level)
    {
        // Pre-marshal throttle: skip Dispatch overhead when level is non-zero and interval not elapsed.
        if (level != 0)
        {
            var nowMs  = Environment.TickCount64;
            var lastMs = Interlocked.Read(ref _lastLevelUpdateMs);
            if (nowMs - lastMs < LevelThrottleMs) return;
        }
        Dispatch(() =>
        {
            if (!GuardToken(token, "level")) return;
            if (!_windowController.IsVisible) return;
            // Second throttle check on UI thread (authoritative).
            if (level != 0 && Environment.TickCount64 - _lastLevelUpdateMs < LevelThrottleMs) return;
            _lastLevelUpdateMs = Environment.TickCount64;
            if (_vm != null) _vm.MicLevel = Math.Clamp(level, 0, 1);
        });
    }

    // ── Public session helpers ─

    internal void UserBeganEditing()
        => Dispatch(() =>
        {
            CancelAutoSend();
            if (_vm != null) { _vm.IsSending = false; _vm.IsEditing = true; }
        });

    internal void CancelEditingAndDismiss()
        => Dispatch(() =>
        {
            CancelAutoSend();
            if (_vm != null) { _vm.IsSending = false; _vm.IsEditing = false; }
            if (_activeToken.HasValue)
                DismissCore(_activeToken.Value, VoiceDismissReason.Explicit, VoiceSendOutcome.Empty);
        });

    internal void EndEditing()
        => Dispatch(() => { if (_vm != null) _vm.IsEditing = false; });

    internal void UpdateText(string text)
        => Dispatch(() =>
        {
            if (_vm == null) return;
            _vm.TranscriptText = text;
            _vm.IsSending      = false;
        });

    internal void RequestSend(Guid? token = null, string reason = "overlay_request")
        => Dispatch(() =>
        {
            if (!GuardToken(token, "requestSend")) return;
            var active = token ?? _activeToken;
            if (!active.HasValue) return;
            GetNotifier()?.SendNow(active.Value, reason);
        });

    internal (Guid? Token, VoiceSessionSource? Source, string Text, bool IsVisible) Snapshot()
        => (_activeToken, _activeSource, _vm?.TranscriptText ?? string.Empty, _windowController.IsVisible);

    // ── Token guard

    internal static GuardOutcome EvaluateToken(Guid? active, Guid? incoming)
    {
        if (active is null) return GuardOutcome.DropNoActive;
        if (incoming.HasValue && incoming.Value != active.Value) return GuardOutcome.DropMismatch;
        return GuardOutcome.Accept;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private bool GuardToken(Guid? token, string context)
    {
        switch (EvaluateToken(_activeToken, token))
        {
            case GuardOutcome.Accept:
                return true;
            case GuardOutcome.DropMismatch:
                _logger.LogInformation(
                    "overlay drop {Context} token_mismatch active={Active} got={Got}",
                    context, _activeToken, token);
                return false;
            default: // DropNoActive
                _logger.LogInformation("overlay drop {Context} no_active", context);
                return false;
        }
    }

    // Core dismiss — called only from within a Dispatch callback (already on UI thread).
    private void DismissCore(Guid token, VoiceDismissReason reason, VoiceSendOutcome outcome)
    {
        if (!GuardToken(token, "dismiss")) return;
        _logger.LogInformation(
            "overlay dismiss token={Token} reason={Reason} outcome={Outcome} visible={Vis} sending={Send}",
            _activeToken, reason, outcome, _windowController.IsVisible, _vm?.IsSending);
        CancelAutoSend();
        if (_vm != null) { _vm.IsSending = false; _vm.IsEditing = false; }

        var dismissedToken = _activeToken;
        _lastLevelUpdateMs = 0;
        _activeToken       = null;
        _activeSource      = null;
        _vm                = null;

        // Delegates window close + animation to window controller.
        // Notifier callback fires after dismiss animation (or immediately in headless mode).
        _windowController.Dismiss(reason, outcome, onDismissed: () =>
            GetNotifier()?.OverlayDidDismiss(dismissedToken));
    }

    private void ScheduleAutoSend(Guid token, double delaySeconds)
    {
        _logger.LogInformation(
            "overlay scheduleAutoSend token={Token} after={Delay}", token, delaySeconds);
        _autoSendCts?.Cancel();
        _autoSendToken = token;
        var cts = new CancellationTokenSource();
        _autoSendCts = cts;
        var ms = (int)(Math.Max(0, delaySeconds) * 1000);
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(ms, cts.Token);
                Dispatch(() =>
                {
                    if (!GuardToken(token, "autoSend")) return;
                    _logger.LogInformation("overlay autoSend firing token={Token}", token);
                    GetNotifier()?.SendNow(token, "autoSendDelay");
                    _autoSendCts = null;
                });
            }
            catch (OperationCanceledException) { }
        });
    }

    private void CancelAutoSend()
    {
        _autoSendCts?.Cancel();
        _autoSendCts   = null;
        _autoSendToken = null;
    }

    private void Present()
    {
        if (_vm is null) return;
        _windowController.Present(_vm);
    }

    private void EnsureVm()
    {
        _vm ??= _services.GetRequiredService<VoiceOverlayViewModel>();
    }

    private void Dispatch(Action action)
    {
        if (_queue is null) { action(); return; }
        _queue.TryEnqueue(() => action());
    }

    private IVoiceSessionNotifier? GetNotifier()
        => _services.GetService<IVoiceSessionNotifier>();
}
