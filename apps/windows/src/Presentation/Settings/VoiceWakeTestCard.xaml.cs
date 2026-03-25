using OpenClawWindows.Application.VoiceWake;

namespace OpenClawWindows.Presentation.Settings;

/// <summary>
/// State-to-visual mapping lives in static helpers (testable without WinRT).
/// </summary>
internal sealed partial class VoiceWakeTestCard : UserControl
{
    public static readonly DependencyProperty TestStateProperty =
        DependencyProperty.Register(nameof(TestState), typeof(VoiceWakeTestState), typeof(VoiceWakeTestCard),
            new PropertyMetadata(VoiceWakeTestState.Idle.Instance, (d, _) => ((VoiceWakeTestCard)d).ApplyState()));

    public static readonly DependencyProperty IsTestingProperty =
        DependencyProperty.Register(nameof(IsTesting), typeof(bool), typeof(VoiceWakeTestCard),
            new PropertyMetadata(false, (d, _) => ((VoiceWakeTestCard)d).ApplyIsTesting()));

    public VoiceWakeTestState TestState
    {
        get => (VoiceWakeTestState)GetValue(TestStateProperty);
        set => SetValue(TestStateProperty, value);
    }

    public bool IsTesting
    {
        get => (bool)GetValue(IsTestingProperty);
        set => SetValue(IsTestingProperty, value);
    }

    // Fires when the user presses Start/Stop — page wires this to the VM command.
    public event RoutedEventHandler? ToggleRequested;

    public VoiceWakeTestCard()
    {
        InitializeComponent();
        ApplyState();
    }

    // ── State → visual mappings (static = testable) ───────────────────────────

    internal static string StatusText(VoiceWakeTestState state) => state switch
    {
        VoiceWakeTestState.Idle      => "Press Start, say a trigger word, and wait for detection.",
        VoiceWakeTestState.Listening => "Listening\u2026 say your trigger word.",
        VoiceWakeTestState.Hearing h => $"Heard: {h.Text}",
        VoiceWakeTestState.Finalizing => "Finalizing\u2026",
        VoiceWakeTestState.Detected  => "Voice wake detected!",
        VoiceWakeTestState.Failed f  => f.Message,
        _                            => string.Empty,
    };

    internal static string? HeardSubText(VoiceWakeTestState state) =>
        state is VoiceWakeTestState.Detected d ? $"Heard: {d.Command}" : null;

    internal static Visibility SpinnerVisibility(VoiceWakeTestState state) =>
        state is VoiceWakeTestState.Finalizing ? Visibility.Visible : Visibility.Collapsed;

    internal static Visibility IconVisibility(VoiceWakeTestState state) =>
        state is VoiceWakeTestState.Finalizing ? Visibility.Collapsed : Visibility.Visible;

    // Segoe MDL2 Assets glyphs
    // waveform → E767 (Microphone), ear.and.waveform → E720 (EarPhone), checkmark → E73E, warning → E783
    internal static string StatusGlyph(VoiceWakeTestState state) => state switch
    {
        VoiceWakeTestState.Detected  => "\uE73E",  // CheckMark
        VoiceWakeTestState.Failed    => "\uE783",  // Error/Warning
        VoiceWakeTestState.Listening => "\uE720",  // EarPhone — Listening…
        VoiceWakeTestState.Hearing   => "\uE720",
        _                            => "\uE767",  // Microphone — Idle/Finalizing
    };

    // ── Private helpers ───────────────────────────────────────────────────────

    private void ApplyState()
    {
        var state    = TestState;
        var heard    = HeardSubText(state);

        StatusSpinner.IsActive    = state is VoiceWakeTestState.Finalizing;
        StatusSpinner.Visibility  = SpinnerVisibility(state);
        StatusIcon.Visibility     = IconVisibility(state);
        StatusIcon.Glyph          = StatusGlyph(state);
        StatusLabel.Text          = StatusText(state);
        HeardText.Text            = heard ?? string.Empty;
        HeardText.Visibility      = heard is not null ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ApplyIsTesting()
    {
        // stop.circle.fill → E769 (StopSolid), play.circle → E768 (Play)
        if (IsTesting)
        {
            ToggleIcon.Glyph  = "\uE769";  // StopSolid
            ToggleLabel.Text  = "Stop";
        }
        else
        {
            ToggleIcon.Glyph  = "\uE768";  // Play
            ToggleLabel.Text  = "Start test";
        }
    }

    private void OnToggleClicked(object sender, RoutedEventArgs e)
        => ToggleRequested?.Invoke(this, e);
}
