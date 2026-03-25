using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using OpenClawWindows.Domain.TalkMode;
using OpenClawWindows.Presentation.ViewModels;
using Windows.Graphics;

namespace OpenClawWindows.Presentation.Windows;

internal sealed partial class TalkOverlayWindow : Window
{
    private readonly TalkOverlayViewModel _vm;
    private readonly DispatcherQueue _queue;
    private DispatcherQueueTimer? _animTimer;
    private double _animTime;

    // Tunables
    private const int OverlaySize = 440;
    private const double AnimFps   = 30.0;

    public TalkOverlayWindow(TalkOverlayViewModel vm)
    {
        _vm    = vm;
        _queue = DispatcherQueue.GetForCurrentThread();

        InitializeComponent();
        if (Content is FrameworkElement fe) fe.DataContext = vm;

        ConfigurePresenter();
        PositionTopRight();
        StartAnimationTimer();

        Closed += (_, _) => _animTimer?.Stop();
    }

    // ── Window setup ─────────────────────────────────────────────────────────

    private void ConfigurePresenter()
    {
        // Borderless always-on-top overlay
        var presenter = (AppWindow.Presenter as OverlappedPresenter)
                     ?? OverlappedPresenter.Create();
        presenter.SetBorderAndTitleBar(hasBorder: false, hasTitleBar: false);
        presenter.IsAlwaysOnTop  = true;
        presenter.IsResizable    = false;
        presenter.IsMinimizable  = false;
        presenter.IsMaximizable  = false;
        AppWindow.SetPresenter(presenter);
        AppWindow.Resize(new SizeInt32(OverlaySize, OverlaySize));
    }

    private void PositionTopRight()
    {
        // top-right of primary work area.
        var display  = DisplayArea.Primary;
        var workArea = display.WorkArea;
        AppWindow.Move(new PointInt32(
            workArea.X + workArea.Width  - OverlaySize,
            workArea.Y));
    }

    // ── Animation timer ───────────────────────────────────────────────────────

    private void StartAnimationTimer()
    {
        _animTimer = _queue.CreateTimer();
        _animTimer.Interval = TimeSpan.FromSeconds(1.0 / AnimFps);
        _animTimer.IsRepeating = true;
        _animTimer.Tick += OnAnimTick;
        _animTimer.Start();
    }

    private void OnAnimTick(DispatcherQueueTimer sender, object args)
    {
        _animTime += 1.0 / AnimFps;
        TickOrbAnimation(_vm.Phase, _vm.MicLevel, _vm.IsPaused);
    }

    // 1:1 port of TalkOrbView + TalkWaveRings animation math
    private void TickOrbAnimation(TalkModePhase phase, double level, bool paused)
    {
        if (paused)
        {
            _vm.OrbScaleX = 1.0;
            _vm.OrbScaleY = 1.0;
            _vm.WaveRing0Opacity = 0;
            _vm.WaveRing1Opacity = 0;
            _vm.WaveRing2Opacity = 0;
            return;
        }

        // Orb scale — pulse when speaking, swell with level when listening
        double orbScale = phase switch
        {
            TalkModePhase.Speaking   => 1.0 + 0.06 * Math.Sin(_animTime * 6),
            TalkModePhase.Listening  => 1.0 + level * 0.12,
            _                        => 1.0,
        };
        _vm.OrbScaleX = orbScale;
        _vm.OrbScaleY = orbScale;

        // Wave rings — 3 rings with offset phase progression
        double speed = phase switch
        {
            TalkModePhase.Speaking  => 1.4,
            TalkModePhase.Listening => 0.9,
            _                       => 0.6,
        };
        double amplitude = phase switch
        {
            TalkModePhase.Speaking  => 0.95,
            TalkModePhase.Listening => 0.5 + level * 0.7,
            _                       => 0.35,
        };
        double baseAlpha = phase switch
        {
            TalkModePhase.Speaking  => 0.72,
            TalkModePhase.Listening => 0.58 + level * 0.28,
            _                       => 0.40,
        };

        for (int i = 0; i < 3; i++)
        {
            double progress  = (_animTime * speed + i * 0.28) % 1.0;
            double ringScale = 0.75 + progress * amplitude + (phase == TalkModePhase.Listening ? level * 0.15 : 0);
            double opacity   = Math.Max(0, baseAlpha - progress * 0.6);

            switch (i)
            {
                case 0: _vm.WaveRing0Scale = ringScale; _vm.WaveRing0Opacity = opacity; break;
                case 1: _vm.WaveRing1Scale = ringScale; _vm.WaveRing1Opacity = opacity; break;
                case 2: _vm.WaveRing2Scale = ringScale; _vm.WaveRing2Opacity = opacity; break;
            }
        }
    }

    // ── Pointer / gesture handlers ────────────────────────────────────────────

    private void OrbHost_PointerEntered(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
        => _vm.IsHovering = true;

    private void OrbHost_PointerExited(object sender, Microsoft.UI.Xaml.Input.PointerRoutedEventArgs e)
        => _vm.IsHovering = false;

    // Drag to reposition window
    private void OrbHost_ManipulationDelta(object sender, Microsoft.UI.Xaml.Input.ManipulationDeltaRoutedEventArgs e)
    {
        var pos = AppWindow.Position;
        AppWindow.Move(new PointInt32(
            (int)(pos.X + e.Delta.Translation.X),
            (int)(pos.Y + e.Delta.Translation.Y)));
    }

    // Single tap = toggle pause
    private void OrbCircle_Tapped(object sender, Microsoft.UI.Xaml.Input.TappedRoutedEventArgs e)
        => _vm.TogglePausedCommand.Execute(null);

    // Double-tap = stop speaking
    private void OrbCircle_DoubleTapped(object sender, Microsoft.UI.Xaml.Input.DoubleTappedRoutedEventArgs e)
        => _ = _vm.StopSpeakingCommand.ExecuteAsync(null);
}
