namespace OpenClawWindows.Presentation.Tray.Components;

internal sealed partial class MenuSessionsHeaderView : UserControl
{
    public static readonly DependencyProperty CountProperty =
        DependencyProperty.Register(nameof(Count), typeof(int), typeof(MenuSessionsHeaderView),
            new PropertyMetadata(0, (d, _) => ((MenuSessionsHeaderView)d).ApplySubtitle()));

    public static readonly DependencyProperty StatusTextProperty =
        DependencyProperty.Register(nameof(StatusText), typeof(string), typeof(MenuSessionsHeaderView),
            new PropertyMetadata(null, (d, _) => ((MenuSessionsHeaderView)d).ApplyStatusText()));

    public int Count
    {
        get => (int)GetValue(CountProperty);
        set => SetValue(CountProperty, value);
    }

    public string? StatusText
    {
        get => (string?)GetValue(StatusTextProperty);
        set => SetValue(StatusTextProperty, value);
    }

    public MenuSessionsHeaderView()
    {
        InitializeComponent();
    }

    internal static string Subtitle(int count) =>
        count == 1 ? "1 session · 24h" : $"{count} sessions · 24h";

    private void ApplySubtitle()   => Card.Subtitle    = Subtitle(Count);
    private void ApplyStatusText() => Card.StatusText  = StatusText;
}
