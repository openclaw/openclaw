using Microsoft.UI;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using System.Windows.Input;
using Windows.UI;
using WinUIApplication = Microsoft.UI.Xaml.Application;

namespace OpenClawWindows.Presentation.Components;

internal sealed partial class SelectableRow : UserControl
{
    // Tunables
    private const double HorizontalPadding      = 10;
    private const double VerticalPadding         = 8;
    private const double CornerRadiusValue       = 10;
    private const double BorderThicknessValue    = 1;
    private const byte   SelectedBgAlpha         = 31;  // accentColor.opacity(0.12) → 0.12*255≈31
    private const byte   HoveredBgAlpha          = 20;  // secondary.opacity(0.08)   → 0.08*255≈20
    private const byte   SelectedBorderAlpha     = 115; // accentColor.opacity(0.45) → 0.45*255≈115

    public static readonly DependencyProperty IsSelectedProperty =
        DependencyProperty.Register(nameof(IsSelected), typeof(bool), typeof(SelectableRow),
            new PropertyMetadata(false, (d, _) => ((SelectableRow)d).UpdateVisualState()));

    public static readonly DependencyProperty RowContentProperty =
        DependencyProperty.Register(nameof(RowContent), typeof(object), typeof(SelectableRow),
            new PropertyMetadata(null, (d, e) => ((SelectableRow)d).RowContentPresenter.Content = e.NewValue));

    public static readonly DependencyProperty CommandProperty =
        DependencyProperty.Register(nameof(Command), typeof(ICommand), typeof(SelectableRow),
            new PropertyMetadata(null));

    public static readonly DependencyProperty CommandParameterProperty =
        DependencyProperty.Register(nameof(CommandParameter), typeof(object), typeof(SelectableRow),
            new PropertyMetadata(null));

    public bool IsSelected
    {
        get => (bool)GetValue(IsSelectedProperty);
        set => SetValue(IsSelectedProperty, value);
    }

    public object? RowContent
    {
        get => GetValue(RowContentProperty);
        set => SetValue(RowContentProperty, value);
    }

    public ICommand? Command
    {
        get => (ICommand?)GetValue(CommandProperty);
        set => SetValue(CommandProperty, value);
    }

    public object? CommandParameter
    {
        get => GetValue(CommandParameterProperty);
        set => SetValue(CommandParameterProperty, value);
    }

    private bool _isHovered;

    public SelectableRow()
    {
        InitializeComponent();
        Container.Padding = new Thickness(HorizontalPadding, VerticalPadding, HorizontalPadding, VerticalPadding);
        Tapped += OnTapped;
        PointerEntered += OnPointerEntered;
        PointerExited += OnPointerExited;
        UpdateVisualState();
    }

    private void OnTapped(object sender, TappedRoutedEventArgs e)
    {
        if (Command?.CanExecute(CommandParameter) == true)
            Command.Execute(CommandParameter);
    }

    private void OnPointerEntered(object sender, PointerRoutedEventArgs e)
    {
        _isHovered = true;
        UpdateVisualState();
    }

    private void OnPointerExited(object sender, PointerRoutedEventArgs e)
    {
        _isHovered = false;
        UpdateVisualState();
    }

    private void UpdateVisualState()
    {
        var accent = GetAccentColor();

        if (IsSelected)
        {
            Container.Background  = new SolidColorBrush(SelectedBackgroundColor(accent));
            Container.BorderBrush = new SolidColorBrush(SelectedBorderColor(accent));
        }
        else if (_isHovered)
        {
            Container.Background  = new SolidColorBrush(HoveredBackgroundColor());
            Container.BorderBrush = new SolidColorBrush(Colors.Transparent);
        }
        else
        {
            Container.Background  = new SolidColorBrush(Colors.Transparent);
            Container.BorderBrush = new SolidColorBrush(Colors.Transparent);
        }
    }

    private static Color GetAccentColor()
    {
        try { return (Color)WinUIApplication.Current.Resources["SystemAccentColor"]; }
        catch { return Colors.Blue; }
    }

    // Exposed as internal so tests can verify alpha values without a WinRT host.

    internal static Color SelectedBackgroundColor(Color accent) =>
        Color.FromArgb(SelectedBgAlpha, accent.R, accent.G, accent.B);

    internal static Color SelectedBorderColor(Color accent) =>
        Color.FromArgb(SelectedBorderAlpha, accent.R, accent.G, accent.B);

    internal static Color HoveredBackgroundColor() =>
        Color.FromArgb(HoveredBgAlpha, 128, 128, 128);
}

/// <summary>
/// shows a filled checkmark (selected) or directional arrow (not selected).
/// </summary>
internal sealed class SelectionStateIndicator : UserControl
{
    private readonly FontIcon _icon;

    public static readonly DependencyProperty IsSelectedProperty =
        DependencyProperty.Register(nameof(IsSelected), typeof(bool), typeof(SelectionStateIndicator),
            new PropertyMetadata(false, (d, _) => ((SelectionStateIndicator)d).Update()));

    public bool IsSelected
    {
        get => (bool)GetValue(IsSelectedProperty);
        set => SetValue(IsSelectedProperty, value);
    }

    public SelectionStateIndicator()
    {
        _icon = new FontIcon
        {
            FontFamily = new FontFamily("Segoe MDL2 Assets"),
            FontSize = 16,
        };
        Content = _icon;
        Update();
    }

    private void Update()
    {
        if (IsSelected)
        {
            _icon.Glyph = "\uE930"; // Completed — checkmark in circle (Segoe MDL2 Assets)
            _icon.Foreground = GetBrushOrNull("SystemControlHighlightAccentBrush")
                ?? new SolidColorBrush(Colors.Blue);
        }
        else
        {
            _icon.Glyph = "\uE76C"; // ChevronRightMed (Segoe MDL2 Assets)
            _icon.Foreground = GetBrushOrNull("TextFillColorSecondaryBrush")
                ?? new SolidColorBrush(Colors.Gray);
        }
    }

    private static Brush? GetBrushOrNull(string key)
    {
        try { return WinUIApplication.Current?.Resources[key] as Brush; }
        catch { return null; }
    }
}
