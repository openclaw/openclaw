using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Windows.System;
using Windows.UI.Core;

namespace OpenClawWindows.Presentation.Voice;

/// <summary>
/// Editable transcript field for the voice overlay.
/// </summary>
internal sealed partial class VoiceOverlayEditableTextView : UserControl
{
    private bool _isEditing;
    private bool _isProgrammaticUpdate;

    // ── Input properties ──────────────────────────────────────────────────

    public string CommittedText
    {
        get => (string)GetValue(CommittedTextProperty);
        set => SetValue(CommittedTextProperty, value);
    }
    public static readonly DependencyProperty CommittedTextProperty =
        DependencyProperty.Register(nameof(CommittedText), typeof(string),
            typeof(VoiceOverlayEditableTextView),
            new PropertyMetadata(string.Empty, OnFormattingChanged));

    public string VolatileText
    {
        get => (string)GetValue(VolatileTextProperty);
        set => SetValue(VolatileTextProperty, value);
    }
    public static readonly DependencyProperty VolatileTextProperty =
        DependencyProperty.Register(nameof(VolatileText), typeof(string),
            typeof(VoiceOverlayEditableTextView),
            new PropertyMetadata(string.Empty, OnFormattingChanged));

    public bool IsFinal
    {
        get => (bool)GetValue(IsFinalProperty);
        set => SetValue(IsFinalProperty, value);
    }
    public static readonly DependencyProperty IsFinalProperty =
        DependencyProperty.Register(nameof(IsFinal), typeof(bool),
            typeof(VoiceOverlayEditableTextView),
            new PropertyMetadata(false, OnFormattingChanged));

    // received by caller, not used for internal rendering.
    public bool IsOverflowing
    {
        get => (bool)GetValue(IsOverflowingProperty);
        set => SetValue(IsOverflowingProperty, value);
    }
    public static readonly DependencyProperty IsOverflowingProperty =
        DependencyProperty.Register(nameof(IsOverflowing), typeof(bool),
            typeof(VoiceOverlayEditableTextView),
            new PropertyMetadata(false));

    // ── Output property ───────────────────────────────────────────────────

    // String — reflects user-edited plain text.
    public string EditedText
    {
        get => (string)GetValue(EditedTextProperty);
        set => SetValue(EditedTextProperty, value);
    }
    public static readonly DependencyProperty EditedTextProperty =
        DependencyProperty.Register(nameof(EditedText), typeof(string),
            typeof(VoiceOverlayEditableTextView),
            new PropertyMetadata(string.Empty));

    // ── Callbacks ─────────────────────────────────────────────────────────

    public Action? OnBeginEditing { get; set; }
    public Action? OnEndEditing   { get; set; }
    public Action? OnSend         { get; set; }
    public Action? OnEscape       { get; set; }

    public VoiceOverlayEditableTextView()
    {
        InitializeComponent();
    }

    // ── Formatting ────────────────────────────────────────────────────────

    private static void OnFormattingChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
    {
        ((VoiceOverlayEditableTextView)d).RefreshFormattedText();
    }

    private void RefreshFormattedText()
    {
        if (_isEditing) return;

        _isProgrammaticUpdate = true;
        try
        {
            ApplyFormattedText(
                CommittedText ?? string.Empty,
                VolatileText  ?? string.Empty,
                IsFinal);
        }
        finally
        {
            _isProgrammaticUpdate = false;
        }
    }

    private void ApplyFormattedText(string committed, string volatile_, bool isFinal)
    {
        var doc = EditBox.Document;
        doc.SetText(TextSetOptions.None, committed + volatile_);

        if (!isFinal && volatile_.Length > 0)
        {
            var range = doc.GetRange(committed.Length, committed.Length + volatile_.Length);
            range.CharacterFormat.ForegroundColor = VoiceOverlayTextFormatter.VolatileDimColor;
        }
    }

    // ── Focus ─────────────────────────────────────────────────────────────

    private void EditBox_GotFocus(object sender, RoutedEventArgs e)
    {
        _isEditing = true;
        OnBeginEditing?.Invoke();
    }

    private void EditBox_LostFocus(object sender, RoutedEventArgs e)
    {
        _isEditing = false;
        OnEndEditing?.Invoke();
    }

    // ── Text change ───────────────────────────────────────────────────────

    private void EditBox_TextChanged(object sender, RoutedEventArgs e)
    {
        if (_isProgrammaticUpdate) return;
        if (!_isEditing) return;

        EditBox.Document.GetText(TextGetOptions.None, out var text);
        EditedText = StripTrailingCarriageReturn(text);
    }

    // ── Keyboard ──────────────────────────────────────────────────────────

    // RichEditBox always appends a trailing \r to its content — strip it so the output
    // matches the plain-string binding that the Swift @Binding var text: String carries.
    internal static string StripTrailingCarriageReturn(string text) =>
        text.EndsWith('\r') ? text[..^1] : text;

    private void EditBox_PreviewKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Escape)
        {
            OnEscape?.Invoke();
            e.Handled = true;
            return;
        }

        if (e.Key == VirtualKey.Enter)
        {
            var shiftState = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift);
            bool isShift = shiftState.HasFlag(CoreVirtualKeyStates.Down);

            if (isShift)
                return;

            // IME composition: WinUI3 intercepts Enter at the IME layer before PreviewKeyDown,
            // so reaching here with Enter means IME has already committed — matches hasMarkedText check.
            e.Handled = true;

            EditBox.IsEnabled = false;
            EditBox.IsEnabled = true;
            OnSend?.Invoke();
        }
    }
}
