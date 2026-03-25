using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace OpenClawWindows.Presentation.Voice;

/// <summary>
/// Read-only transcript label for the voice overlay.
/// </summary>
internal sealed partial class VoiceOverlayReadOnlyLabel : UserControl
{
    // ── Input properties ──────────────────────────────────────────────────

    public string CommittedText
    {
        get => (string)GetValue(CommittedTextProperty);
        set => SetValue(CommittedTextProperty, value);
    }
    public static readonly DependencyProperty CommittedTextProperty =
        DependencyProperty.Register(nameof(CommittedText), typeof(string),
            typeof(VoiceOverlayReadOnlyLabel),
            new PropertyMetadata(string.Empty, OnFormattingChanged));

    public string VolatileText
    {
        get => (string)GetValue(VolatileTextProperty);
        set => SetValue(VolatileTextProperty, value);
    }
    public static readonly DependencyProperty VolatileTextProperty =
        DependencyProperty.Register(nameof(VolatileText), typeof(string),
            typeof(VoiceOverlayReadOnlyLabel),
            new PropertyMetadata(string.Empty, OnFormattingChanged));

    public bool IsFinal
    {
        get => (bool)GetValue(IsFinalProperty);
        set => SetValue(IsFinalProperty, value);
    }
    public static readonly DependencyProperty IsFinalProperty =
        DependencyProperty.Register(nameof(IsFinal), typeof(bool),
            typeof(VoiceOverlayReadOnlyLabel),
            new PropertyMetadata(false, OnFormattingChanged));

    // ── Callback ──────────────────────────────────────────────────────────

    // fired when the label is tapped/clicked.
    public Action? OnTap { get; set; }

    public VoiceOverlayReadOnlyLabel()
    {
        InitializeComponent();
    }

    // ── Formatting ────────────────────────────────────────────────────────

    private static void OnFormattingChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        ((VoiceOverlayReadOnlyLabel)d).RefreshRuns();
    }

    // Returns (committed, volatile_) with nulls coerced to empty string so MakeRuns
    // never receives null
    internal static (string Committed, string Volatile) CoerceInputs(string? committed, string? volatile_) =>
        (committed ?? string.Empty, volatile_ ?? string.Empty);

    private void RefreshRuns()
    {
        var (c, v) = CoerceInputs(CommittedText, VolatileText);
        var (committed, volatile_) = VoiceOverlayTextFormatter.MakeRuns(c, v, IsFinal);

        // Committed run inherits TextElement.Foreground (= theme labelColor) — no explicit brush set.
        // Volatile run uses VolatileDimColor when !isFinal (already applied by MakeRuns).
        var para = new Paragraph();
        para.Inlines.Add(committed);
        para.Inlines.Add(volatile_);

        Label.Blocks.Clear();
        Label.Blocks.Add(para);
    }

    private void TapArea_Tapped(object sender, TappedRoutedEventArgs e)
    {
        OnTap?.Invoke();
    }
}
