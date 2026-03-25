namespace OpenClawWindows.Presentation.Tray.Components;

internal sealed partial class MenuUsageHeaderView : UserControl
{
    public static readonly DependencyProperty CountProperty =
        DependencyProperty.Register(nameof(Count), typeof(int), typeof(MenuUsageHeaderView),
            new PropertyMetadata(0, (d, _) => ((MenuUsageHeaderView)d).ApplySubtitle()));

    public int Count
    {
        get => (int)GetValue(CountProperty);
        set => SetValue(CountProperty, value);
    }

    public MenuUsageHeaderView()
    {
        InitializeComponent();
    }

    internal static string Subtitle(int count) =>
        count == 1 ? "1 provider" : $"{count} providers";

    private void ApplySubtitle() => Card.Subtitle = Subtitle(Count);
}
