using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Domain.WorkActivity;

namespace OpenClawWindows.Presentation.Tray;

// COM-free enum; View maps to WinUI3 Colors at render time.
internal enum BadgeColorKind { None, Red, Orange }

/// <summary>
/// Drives the animated critter tray icon state
/// Manages the tick loop and animation value properties consumed by the tray icon View.
/// </summary>
internal sealed partial class CritterStatusLabelViewModel : ObservableObject, IDisposable
{
    // Tunables
    private const int    TickIntervalMs          = 350;
    private const int    BlinkSleepMs            = 160;
    private const int    WiggleSleepMs           = 360;
    private const int    LegWiggleSleepMs        = 220;
    private const int    ScurrySleepMs           = 180;
    private const int    EarWiggleSleepMs        = 320;
    private const double NextBlinkMin            = 3.5;
    private const double NextBlinkMax            = 8.5;
    private const double NextWiggleMin           = 6.5;
    private const double NextWiggleMax           = 14.0;
    private const double NextLegWiggleMin        = 5.0;
    private const double NextLegWiggleMax        = 11.0;
    private const double NextEarWiggleMin        = 7.0;
    private const double NextEarWiggleMax        = 14.0;
    private const double WiggleAngleMin          = -4.5;
    private const double WiggleAngleMax          = 4.5;
    private const double WiggleOffsetMin         = -0.5;
    private const double WiggleOffsetMax         = 0.5;
    private const double LegWiggleTargetMin      = 0.35;
    private const double LegWiggleTargetMax      = 0.90;
    private const double ScurryTargetMin         = 0.7;
    private const double ScurryTargetMax         = 1.0;
    private const double ScurryLegWiggleFinal    = 0.25;  // leg wiggle value after scurry settle
    private const double ScurryOffsetMin         = -0.6;
    private const double ScurryOffsetMax         = 0.6;
    private const double EarWiggleTargetMin      = -1.2;
    private const double EarWiggleTargetMax      = 1.2;
    internal const double EarScaleBoost          = 1.9;   // ear scale when boost active
    internal const double LegWiggleWorkingBoost  = 0.6;   // minimum leg wiggle amplitude while working

    private readonly IWorkActivityStore _activityStore;
    private readonly IGatewayProcessManager _gatewayManager;
    private readonly DispatcherQueue _dispatcherQueue;
    private readonly Random _rng = new();

    // Tick loop cancellation
    private CancellationTokenSource? _cts;

    // Next-fire timestamps
    private DateTime _nextBlink;
    private DateTime _nextWiggle;
    private DateTime _nextLegWiggle;
    private DateTime _nextEarWiggle;

    // ── Input state (settable by MenuContentView parent) ──────────────────────

    [ObservableProperty] private bool _isPaused;
    [ObservableProperty] private bool _isSleeping;
    [ObservableProperty] private bool _earBoostActive;
    [ObservableProperty] private bool _animationsEnabled;

    // ── Derived state ─────────────────────────────────────────────────────────

    [ObservableProperty] private IconState _iconState = new IconState.Idle();
    [ObservableProperty] private GatewayProcessStatus _gatewayStatus = GatewayProcessStatus.Stopped();

    // ── Animation values ─────────

    [ObservableProperty] private double _blinkAmount;
    [ObservableProperty] private double _wiggleAngle;
    [ObservableProperty] private double _wiggleOffset;
    [ObservableProperty] private double _legWiggle;
    [ObservableProperty] private double _earWiggle;

    // ── Computed ──────────────────────────────────────────────────────────────

    public bool IsWorkingNow => IconState.IsWorking;

    private bool EffectiveAnimationsEnabled => AnimationsEnabled && !IsSleeping;

    // extracted static for unit tests
    public bool GatewayNeedsAttention =>
        ComputeGatewayNeedsAttention(GatewayStatus, IsSleeping, IsPaused);

    // extracted static for unit tests
    public BadgeColorKind GatewayBadgeColor => ComputeGatewayBadgeColor(GatewayStatus);

    // ── Static helpers (extracted for unit-testability) ───────────────────────

    internal static bool ComputeGatewayNeedsAttention(
        GatewayProcessStatus status, bool isSleeping, bool isPaused)
    {
        if (isSleeping) return false;
        return status.Kind switch
        {
            GatewayProcessStatusKind.Failed  => !isPaused,
            GatewayProcessStatusKind.Stopped => !isPaused,
            _                                => false,
        };
    }

    internal static BadgeColorKind ComputeGatewayBadgeColor(GatewayProcessStatus status) =>
        status.Kind switch
        {
            GatewayProcessStatusKind.Failed  => BadgeColorKind.Red,
            GatewayProcessStatusKind.Stopped => BadgeColorKind.Orange,
            _                                => BadgeColorKind.None,
        };

    // ── Constructor ───────────────────────────────────────────────────────────

    public CritterStatusLabelViewModel(
        IWorkActivityStore activityStore,
        IGatewayProcessManager gatewayManager,
        DispatcherQueue dispatcherQueue)
    {
        _activityStore   = activityStore;
        _gatewayManager  = gatewayManager;
        _dispatcherQueue = dispatcherQueue;

        _activityStore.StateChanged += OnActivityStateChanged;

        IconState    = _activityStore.IconState;
        GatewayStatus = _gatewayManager.Status;

        ScheduleRandomTimers(DateTime.UtcNow);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    // triggers a blink when the external tick increments
    public void TriggerBlink()
    {
        if (!EffectiveAnimationsEnabled || EarBoostActive) return;
        _ = BlinkAsync();
    }

    // triggers a leg-wiggle celebration
    public void TriggerCelebration()
    {
        if (!EffectiveAnimationsEnabled || EarBoostActive) return;
        _ = WiggleLegsAsync();
    }

    // Call when gateway process status changes externally
    public void RefreshGatewayStatus()
    {
        _dispatcherQueue.TryEnqueue(() =>
        {
            GatewayStatus = _gatewayManager.Status;
            OnPropertyChanged(nameof(GatewayNeedsAttention));
            OnPropertyChanged(nameof(GatewayBadgeColor));
        });
    }

    // ── Partial callbacks (CommunityToolkit.Mvvm) ─────────────────────────────

    partial void OnIsPausedChanged(bool value) => ResetMotion();

    // also restarts loop (tickTaskID changes)
    partial void OnIsSleepingChanged(bool value)
    {
        ResetMotion();
        RestartTickLoop();
    }

    partial void OnEarBoostActiveChanged(bool value)
    {
        if (value)
            ResetMotion();
        else if (EffectiveAnimationsEnabled)
            ScheduleRandomTimers(DateTime.UtcNow);

        RestartTickLoop();
    }

    partial void OnAnimationsEnabledChanged(bool value)
    {
        if (value && !IsSleeping)
            ScheduleRandomTimers(DateTime.UtcNow);
        else
            ResetMotion();

        RestartTickLoop();
    }

    // ── Tick loop ──────────────────────────────

    private void RestartTickLoop()
    {
        _cts?.Cancel();
        _cts?.Dispose();

        if (!EffectiveAnimationsEnabled || EarBoostActive)
        {
            _cts = null;
            return;
        }

        var cts = new CancellationTokenSource();
        _cts = cts;
        _ = RunTickLoopAsync(cts.Token);
    }

    private async Task RunTickLoopAsync(CancellationToken ct)
    {
        if (!EffectiveAnimationsEnabled || EarBoostActive)
        {
            _dispatcherQueue.TryEnqueue(ResetMotion);
            return;
        }

        while (!ct.IsCancellationRequested)
        {
            var now = DateTime.UtcNow;
            _dispatcherQueue.TryEnqueue(() => Tick(now));
            try { await Task.Delay(TickIntervalMs, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void Tick(DateTime now)
    {
        if (!EffectiveAnimationsEnabled || EarBoostActive)
        {
            ResetMotion();
            return;
        }

        if (now >= _nextBlink)
        {
            _ = BlinkAsync();
            _nextBlink = now.AddSeconds(RandomIn(NextBlinkMin, NextBlinkMax));
        }

        if (now >= _nextWiggle)
        {
            _ = WiggleAsync();
            _nextWiggle = now.AddSeconds(RandomIn(NextWiggleMin, NextWiggleMax));
        }

        if (now >= _nextLegWiggle)
        {
            _ = WiggleLegsAsync();
            _nextLegWiggle = now.AddSeconds(RandomIn(NextLegWiggleMin, NextLegWiggleMax));
        }

        if (now >= _nextEarWiggle)
        {
            _ = WiggleEarsAsync();
            _nextEarWiggle = now.AddSeconds(RandomIn(NextEarWiggleMin, NextEarWiggleMax));
        }

        if (IsWorkingNow)
            _ = ScurryAsync();
    }

    // ── Animation methods ──

    private async Task BlinkAsync()
    {
        _dispatcherQueue.TryEnqueue(() => BlinkAmount = 1);
        await Task.Delay(BlinkSleepMs);
        _dispatcherQueue.TryEnqueue(() => BlinkAmount = 0);
    }

    private async Task WiggleAsync()
    {
        var angle  = RandomIn(WiggleAngleMin, WiggleAngleMax);
        var offset = RandomIn(WiggleOffsetMin, WiggleOffsetMax);
        _dispatcherQueue.TryEnqueue(() => { WiggleAngle = angle; WiggleOffset = offset; });
        await Task.Delay(WiggleSleepMs);
        _dispatcherQueue.TryEnqueue(() => { WiggleAngle = 0; WiggleOffset = 0; });
    }

    private async Task WiggleLegsAsync()
    {
        var target = RandomIn(LegWiggleTargetMin, LegWiggleTargetMax);
        _dispatcherQueue.TryEnqueue(() => LegWiggle = target);
        await Task.Delay(LegWiggleSleepMs);
        _dispatcherQueue.TryEnqueue(() => LegWiggle = 0);
    }

    private async Task ScurryAsync()
    {
        var leg    = RandomIn(ScurryTargetMin, ScurryTargetMax);
        var offset = RandomIn(ScurryOffsetMin, ScurryOffsetMax);
        _dispatcherQueue.TryEnqueue(() => { LegWiggle = leg; WiggleOffset = offset; });
        await Task.Delay(ScurrySleepMs);
        _dispatcherQueue.TryEnqueue(() => { LegWiggle = ScurryLegWiggleFinal; WiggleOffset = 0; });
    }

    private async Task WiggleEarsAsync()
    {
        var target = RandomIn(EarWiggleTargetMin, EarWiggleTargetMax);
        _dispatcherQueue.TryEnqueue(() => EarWiggle = target);
        await Task.Delay(EarWiggleSleepMs);
        _dispatcherQueue.TryEnqueue(() => EarWiggle = 0);
    }

    private void ResetMotion()
    {
        BlinkAmount  = 0;
        WiggleAngle  = 0;
        WiggleOffset = 0;
        LegWiggle    = 0;
        EarWiggle    = 0;
    }

    private void ScheduleRandomTimers(DateTime from)
    {
        _nextBlink     = from.AddSeconds(RandomIn(NextBlinkMin,    NextBlinkMax));
        _nextWiggle    = from.AddSeconds(RandomIn(NextWiggleMin,   NextWiggleMax));
        _nextLegWiggle = from.AddSeconds(RandomIn(NextLegWiggleMin, NextLegWiggleMax));
        _nextEarWiggle = from.AddSeconds(RandomIn(NextEarWiggleMin, NextEarWiggleMax));
    }

    private double RandomIn(double min, double max) =>
        _rng.NextDouble() * (max - min) + min;

    private void OnActivityStateChanged(object? sender, EventArgs e)
    {
        _dispatcherQueue.TryEnqueue(() =>
        {
            IconState = _activityStore.IconState;
            OnPropertyChanged(nameof(IsWorkingNow));
        });
    }

    public void Dispose()
    {
        _activityStore.StateChanged -= OnActivityStateChanged;
        _cts?.Cancel();
        _cts?.Dispose();
        _cts = null;
    }
}
