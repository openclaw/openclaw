namespace OpenClawWindows.Presentation.Tray.Components;

// inside a tray menu item slot with an explicit fixed width.
internal sealed partial class MenuHostedItem : UserControl
{
    // ── Dependency properties ──────────────────────────────────────────────────

    public static readonly DependencyProperty ContentWidthProperty =
        DependencyProperty.Register(nameof(ContentWidth), typeof(double), typeof(MenuHostedItem),
            new PropertyMetadata(0.0, (d, _) => ((MenuHostedItem)d).ApplySizing()));

    public static readonly DependencyProperty HostedContentProperty =
        DependencyProperty.Register(nameof(HostedContent), typeof(object), typeof(MenuHostedItem),
            new PropertyMetadata(null, (d, _) => ((MenuHostedItem)d).ApplyHostedContent()));

    public double ContentWidth
    {
        get => (double)GetValue(ContentWidthProperty);
        set => SetValue(ContentWidthProperty, value);
    }

    public object? HostedContent
    {
        get => GetValue(HostedContentProperty);
        set => SetValue(HostedContentProperty, value);
    }

    public MenuHostedItem()
    {
        InitializeComponent();
    }

    // let width = max(1, self.width)
    private void ApplySizing() => Width = Math.Max(1.0, ContentWidth);

    private void ApplyHostedContent() => HostedPresenter.Content = HostedContent;
}
