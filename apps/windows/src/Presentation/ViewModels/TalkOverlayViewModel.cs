using OpenClawWindows.Application.TalkMode;
using OpenClawWindows.Domain.TalkMode;
using Windows.UI;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class TalkOverlayViewModel : ObservableObject
{
    private readonly ISender _sender;

    // ── State ─────────────────────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(OrbOpacity), nameof(WaveRingsVisibility))]
    private bool _isPaused;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsHoveringVisibility))]
    private bool _isHovering;

    [ObservableProperty]
    private double _micLevel;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ThinkingRingVisibility), nameof(WaveRingsVisibility))]
    private TalkModePhase _phase = TalkModePhase.Idle;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TranscriptVisibility))]
    private string _transcript = string.Empty;

    // ── Animation properties (driven by DispatcherTimer in code-behind) ───────

    // Tunables
    private const double DefaultAccentR = 79 / 255.0;
    private const double DefaultAccentG = 122 / 255.0;
    private const double DefaultAccentB = 154 / 255.0;

    [ObservableProperty] private double _orbScaleX = 1.0;
    [ObservableProperty] private double _orbScaleY = 1.0;

    [ObservableProperty] private double _waveRing0Scale   = 0.75;
    [ObservableProperty] private double _waveRing1Scale   = 0.75;
    [ObservableProperty] private double _waveRing2Scale   = 0.75;
    [ObservableProperty] private double _waveRing0Opacity;
    [ObservableProperty] private double _waveRing1Opacity;
    [ObservableProperty] private double _waveRing2Opacity;

    // ── Accent color — may be overridden by SeamColorHex from settings ────────

    public Color AccentColor { get; set; } =
        Color.FromArgb(255, (byte)(DefaultAccentR * 255), (byte)(DefaultAccentG * 255), (byte)(DefaultAccentB * 255));

    // ── Derived properties ────────────────────────────────────────────────────

    // Paused orb dims to 55%
    public double OrbOpacity => IsPaused ? 0.55 : 1.0;

    public Visibility IsHoveringVisibility =>
        _isHovering ? Visibility.Visible : Visibility.Collapsed;

    // ProgressRing shown during thinking phase instead of wave rings
    public Visibility ThinkingRingVisibility =>
        _phase == TalkModePhase.Processing ? Visibility.Visible : Visibility.Collapsed;

    // Wave rings shown while active and not paused
    public Visibility WaveRingsVisibility =>
        _phase != TalkModePhase.Idle && !_isPaused ? Visibility.Visible : Visibility.Collapsed;

    public Visibility TranscriptVisibility =>
        !string.IsNullOrEmpty(_transcript) ? Visibility.Visible : Visibility.Collapsed;

    // ─────────────────────────────────────────────────────────────────────────

    public TalkOverlayViewModel(ISender sender)
    {
        _sender = sender;
    }

    // ── Public update API — called by TalkModeController equivalent ───────────

    public void UpdatePhase(TalkModePhase phase) => Phase    = phase;
    public void UpdateLevel(double level)         => MicLevel = Math.Clamp(level, 0, 1);
    public void UpdatePaused(bool paused)         => IsPaused = paused;
    public void SetTranscript(string text)        => Transcript = text ?? string.Empty;

    // ── Commands ──────────────────────────────────────────────────────────────

    [RelayCommand]
    private async Task ExitAsync()
    {
        await _sender.Send(new StopTalkModeCommand("user_exit"));
    }

    [RelayCommand]
    private async Task StopSpeakingAsync()
    {
        // Double-tap stops speaking
        await _sender.Send(new StopTalkModeCommand("user_tap"));
    }

    [RelayCommand]
    private void TogglePaused() => IsPaused = !IsPaused;
}
