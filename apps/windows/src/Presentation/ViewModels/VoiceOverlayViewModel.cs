using OpenClawWindows.Application.TalkMode;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class VoiceOverlayViewModel : ObservableObject
{
    private readonly ISender _sender;

    // ── Text state ────────────────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CommittedText), nameof(VolatileText))]
    private string _transcriptText = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsReadOnly), nameof(CloseButtonVisibility),
        nameof(CommittedText), nameof(VolatileText))]
    private bool _isEditing;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CommittedText), nameof(VolatileText))]
    private bool _isFinal;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSend), nameof(SendingVisibility), nameof(IdleVisibility))]
    private bool _isSending;

    // stored state, not derived from text.
    // Partial transcripts have forwardEnabled=false even if text is non-empty.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSend))]
    private bool _forwardEnabled;

    // ── Hover ─────────────────────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CloseButtonVisibility))]
    private bool _isHovering;

    // ── Mic level VAD ─────────────────────────────────────────────────────────

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(MicLevelBarWidth))]
    private double _micLevel;

    // ── Tunables ──────────────────────────────────────────────────────────────

    private const double SendButtonWidth = 32.0; // px — matches XAML Button Width

    // ── Derived properties ────────────────────────────────────────────────────

    // committed = confirmed text, volatile = in-progress recognition text.
    // IsFinal or IsEditing → whole transcript is committed; otherwise still volatile.
    public string CommittedText => IsFinal || IsEditing ? TranscriptText : string.Empty;
    public string VolatileText  => IsFinal || IsEditing ? string.Empty   : TranscriptText;

    public bool CanSend => ForwardEnabled && !IsSending;

    // IsReadOnly on TextBox: editable only after final transcript (IsEditing=true)
    public bool IsReadOnly => !IsEditing;

    // VAD fill bar width — 0..SendButtonWidth px
    public double MicLevelBarWidth => SendButtonWidth * Math.Max(0, Math.Min(1, MicLevel));

    // Close button visible when hovering OR editing (macOS: isEditing || isHovering || closeHovering)
    public Visibility CloseButtonVisibility =>
        _isHovering || _isEditing ? Visibility.Visible : Visibility.Collapsed;

    // Send button icon swap — paper plane ↔ checkmark
    public Visibility SendingVisibility => _isSending  ? Visibility.Visible : Visibility.Collapsed;
    public Visibility IdleVisibility    => !_isSending ? Visibility.Visible : Visibility.Collapsed;

    // ─────────────────────────────────────────────────────────────────────────

    public VoiceOverlayViewModel(ISender sender)
    {
        _sender = sender;
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    [RelayCommand(CanExecute = nameof(CanSend))]
    private async Task SendAsync()
    {
        IsSending = true;
        IsEditing = false;

        // Brief confirmation window — matches macOS beginSendUI 0.28s delay.
        await Task.Delay(280);

        TranscriptText  = string.Empty;
        IsFinal         = false;
        ForwardEnabled  = false;
        IsSending       = false;
    }

    [RelayCommand]
    private void Dismiss()
    {
        TranscriptText  = string.Empty;
        IsFinal         = false;
        ForwardEnabled  = false;
        IsEditing       = false;
        IsSending       = false;
    }

    // ── Public update API — called by voice wake adapter ─────────────────────

    // Updates live mic level (VAD bar)
    public void UpdateMicLevel(double level) => MicLevel = Math.Clamp(level, 0, 1);

    // Partial transcript from STT — not final yet, not editable.
    // forwardEnabled forced false (even if text non-empty).
    public void UpdatePartial(string text)
    {
        TranscriptText = text;
        IsFinal        = false;
        ForwardEnabled = false;
        IsEditing      = false;
        IsSending      = false;
        MicLevel       = 0;
    }

    // Final transcript — enables send button when text is non-whitespace.
    public void PresentFinal(string text)
    {
        TranscriptText = text;
        IsFinal        = !string.IsNullOrWhiteSpace(text);
        ForwardEnabled = !string.IsNullOrWhiteSpace(text);
        IsEditing      = false;
        IsSending      = false;
        MicLevel       = 0;
    }

    // Called by transcript text view when user starts typing
    public void UserBeganEditing()
    {
        IsEditing = true;
        IsSending = false;
    }

    // Convenience shim for callers that pass (text, isFinal) pair directly.
    public void UpdateTranscript(string text, bool isFinal)
    {
        if (isFinal) PresentFinal(text);
        else         UpdatePartial(text);
    }
}
