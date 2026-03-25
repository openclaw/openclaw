namespace OpenClawWindows.Presentation.Tray.Components;

internal sealed partial class MenuHeaderCard : UserControl
{
    // Tunables
    internal const double DefaultPaddingBottom = 6;
    internal const double PaddingTop           = 8;
    internal const double PaddingLeading       = 20;
    internal const double PaddingTrailing      = 10;
    internal const double Spacing              = 6;
    internal const double CaptionFontSize      = 11;  // caption size
    internal const double MinWidthValue        = 300;

    // ── Dependency properties ──────────────────────────────────────────────────

    public static readonly DependencyProperty TitleProperty =
        DependencyProperty.Register(nameof(Title), typeof(string), typeof(MenuHeaderCard),
            new PropertyMetadata(string.Empty, (d, _) => ((MenuHeaderCard)d).ApplyTitle()));

    public static readonly DependencyProperty SubtitleProperty =
        DependencyProperty.Register(nameof(Subtitle), typeof(string), typeof(MenuHeaderCard),
            new PropertyMetadata(string.Empty, (d, _) => ((MenuHeaderCard)d).ApplySubtitle()));

    public static readonly DependencyProperty StatusTextProperty =
        DependencyProperty.Register(nameof(StatusText), typeof(string), typeof(MenuHeaderCard),
            new PropertyMetadata(null, (d, _) => ((MenuHeaderCard)d).ApplyStatusText()));

    public static readonly DependencyProperty PaddingBottomProperty =
        DependencyProperty.Register(nameof(PaddingBottom), typeof(double), typeof(MenuHeaderCard),
            new PropertyMetadata(DefaultPaddingBottom, (d, _) => ((MenuHeaderCard)d).ApplyPadding()));

    // injectable child UIElement
    public static readonly DependencyProperty HostedContentProperty =
        DependencyProperty.Register(nameof(HostedContent), typeof(object), typeof(MenuHeaderCard),
            new PropertyMetadata(null, (d, _) => ((MenuHeaderCard)d).ApplyHostedContent()));

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public string Subtitle
    {
        get => (string)GetValue(SubtitleProperty);
        set => SetValue(SubtitleProperty, value);
    }

    public string? StatusText
    {
        get => (string?)GetValue(StatusTextProperty);
        set => SetValue(StatusTextProperty, value);
    }

    public double PaddingBottom
    {
        get => (double)GetValue(PaddingBottomProperty);
        set => SetValue(PaddingBottomProperty, value);
    }

    public object? HostedContent
    {
        get => GetValue(HostedContentProperty);
        set => SetValue(HostedContentProperty, value);
    }

    public MenuHeaderCard()
    {
        InitializeComponent();
        ApplyPadding();
    }

    private void ApplyTitle()   => TitleBlock.Text = Title;
    private void ApplySubtitle() => SubtitleBlock.Text = Subtitle;

    private void ApplyStatusText()
    {
        var text = StatusText;
        var visible = !string.IsNullOrEmpty(text);
        StatusBlock.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        if (visible) StatusBlock.Text = text!;
    }

    private void ApplyPadding() =>
        RootPanel.Padding = new Thickness(PaddingLeading, PaddingTop, PaddingTrailing, PaddingBottom);

    private void ApplyHostedContent() =>
        HostedContentPresenter.Content = HostedContent;
}
