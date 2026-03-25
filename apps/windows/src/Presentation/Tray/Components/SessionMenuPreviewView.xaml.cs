using System.ComponentModel;
using System.Linq;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace OpenClawWindows.Presentation.Tray.Components;

/// <summary>
/// Session preview panel for the tray menu.
/// with pre-computed row view-models, eliminating the programmatic Children.Add pattern.
/// </summary>
internal sealed partial class SessionMenuPreviewView : UserControl, INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    // Tunables
    internal const double PaddingVertical  = 6;
    internal const double PaddingLeading   = 16;
    internal const double PaddingTrailing  = 11;
    internal const double CaptionFontSize  = 11;
    internal const double Caption2FontSize = 10;
    internal const double RoleLabelWidth   = 50;
    internal const double Spacing          = 8;
    internal const double ItemSpacing      = 6;
    internal const double RoleSpacing      = 4;

    // ── Dependency properties ─────────────────────────────────────────────────

    public static readonly DependencyProperty TitleProperty =
        DependencyProperty.Register(nameof(Title), typeof(string), typeof(SessionMenuPreviewView),
            new PropertyMetadata(string.Empty, (d, _) => ((SessionMenuPreviewView)d).NotifyAll()));

    public static readonly DependencyProperty MaxLinesProperty =
        DependencyProperty.Register(nameof(MaxLines), typeof(int), typeof(SessionMenuPreviewView),
            new PropertyMetadata(3, (d, _) => ((SessionMenuPreviewView)d).NotifyAll()));

    public static readonly DependencyProperty IsHighlightedProperty =
        DependencyProperty.Register(nameof(IsHighlighted), typeof(bool), typeof(SessionMenuPreviewView),
            new PropertyMetadata(false, (d, _) => ((SessionMenuPreviewView)d).NotifyAll()));

    // Typed as object? so the XAML type scanner does not try to default-construct
    // SessionMenuPreviewSnapshot (record with no parameterless ctor).
    public static readonly DependencyProperty SnapshotProperty =
        DependencyProperty.Register(nameof(Snapshot), typeof(object), typeof(SessionMenuPreviewView),
            new PropertyMetadata(null, (d, _) => ((SessionMenuPreviewView)d).NotifyAll()));

    public string Title
    {
        get => (string)GetValue(TitleProperty);
        set => SetValue(TitleProperty, value);
    }

    public int MaxLines
    {
        get => (int)GetValue(MaxLinesProperty);
        set => SetValue(MaxLinesProperty, value);
    }

    public bool IsHighlighted
    {
        get => (bool)GetValue(IsHighlightedProperty);
        set => SetValue(IsHighlightedProperty, value);
    }

    public object? Snapshot
    {
        get => GetValue(SnapshotProperty);
        set => SetValue(SnapshotProperty, value);
    }

    public SessionMenuPreviewView()
    {
        InitializeComponent();
    }

    // ── x:Bind sources ───────────────────────────────────────────────────────

    public SolidColorBrush TitleForeground   => new(MenuItemHighlightColors.Secondary(IsHighlighted));
    public SolidColorBrush ContentForeground => new(MenuItemHighlightColors.Primary(IsHighlighted));

    public bool IsReady
    {
        get
        {
            var snap = Snapshot as SessionMenuPreviewSnapshot;
            return snap?.Status == PreviewLoadStatus.Ready && snap.Items.Count > 0;
        }
    }

    public bool IsNotReady => !IsReady;

    // Covers Loading / Empty / Error / Ready-but-empty — single placeholder line.
    public string PlaceholderText
    {
        get
        {
            var snap = Snapshot as SessionMenuPreviewSnapshot;
            return snap?.Status switch
            {
                PreviewLoadStatus.Loading                                    => "Loading preview…",
                PreviewLoadStatus.Empty                                      => "No recent messages",
                PreviewLoadStatus.Error                                      => snap.ErrorMessage ?? "Preview unavailable",
                PreviewLoadStatus.Ready when snap.Items.Count == 0          => "No recent messages",
                _                                                            => "Loading preview…",
            };
        }
    }

    // Pre-computes display values per row so the DataTemplate needs no parent access.
    public IReadOnlyList<SessionPreviewRowVM> PreviewRows
    {
        get
        {
            var items      = (Snapshot as SessionMenuPreviewSnapshot)?.Items ?? [];
            var maxLines   = MaxLines;
            var highlighted = IsHighlighted;
            return items.Select(item => new SessionPreviewRowVM(
                item.Role.Label(),
                new SolidColorBrush(RoleColor(item.Role, highlighted)),
                item.Text,
                new SolidColorBrush(MenuItemHighlightColors.Primary(highlighted)),
                maxLines)).ToArray();
        }
    }

    // Fires PropertyChanged for every x:Bind source when any DP changes.
    private void NotifyAll()
    {
        var h = PropertyChanged;
        if (h is null) return;
        h(this, new PropertyChangedEventArgs(nameof(TitleForeground)));
        h(this, new PropertyChangedEventArgs(nameof(ContentForeground)));
        h(this, new PropertyChangedEventArgs(nameof(IsReady)));
        h(this, new PropertyChangedEventArgs(nameof(IsNotReady)));
        h(this, new PropertyChangedEventArgs(nameof(PlaceholderText)));
        h(this, new PropertyChangedEventArgs(nameof(PreviewRows)));
    }

    // ── Color helpers

    // Role colors when highlighted: selectedMenuItemTextColor.opacity(0.9) → 0xE5 ≈ 229
    private const byte HighlightedRoleAlpha = 0xE5;

    internal static Color RoleColor(PreviewRole role, bool highlighted)
    {
        if (highlighted)
            return Color.FromArgb(HighlightedRoleAlpha, 0xFF, 0xFF, 0xFF);

        return role switch
        {
            PreviewRole.User      => Color.FromArgb(0xFF, 0x00, 0x78, 0xD4), // .accentColor → Windows blue
            PreviewRole.Assistant => Color.FromArgb(0x99, 0x00, 0x00, 0x00), // .secondary
            PreviewRole.Tool      => Color.FromArgb(0xFF, 0xFF, 0x8C, 0x00), // .orange
            PreviewRole.System    => Color.FromArgb(0xFF, 0x80, 0x80, 0x80), // .gray
            _                     => Color.FromArgb(0x99, 0x00, 0x00, 0x00)
        };
    }
}

// ── Display view-model for one preview row ────────────────────────────────────
// Pre-computed by SessionMenuPreviewView so the DataTemplate is purely declarative.

internal sealed record SessionPreviewRowVM(
    string           RoleLabel,
    SolidColorBrush  RoleColor,
    string           ItemText,
    SolidColorBrush  TextColor,
    int              MaxLines);

// ── Supporting types ────

internal enum PreviewRole { User, Assistant, Tool, System, Other }

internal static class PreviewRoleExtensions
{
    internal static string Label(this PreviewRole role) => role switch
    {
        PreviewRole.User      => "User",
        PreviewRole.Assistant => "Agent",
        PreviewRole.Tool      => "Tool",
        PreviewRole.System    => "System",
        _                     => "Other"
    };
}

internal sealed class SessionPreviewItem
{
    internal string      Id   { get; init; } = string.Empty;
    internal PreviewRole Role { get; init; }
    internal string      Text { get; init; } = string.Empty;
}

internal enum PreviewLoadStatus { Loading, Ready, Empty, Error }

internal sealed class SessionMenuPreviewSnapshot
{
    internal IReadOnlyList<SessionPreviewItem> Items        { get; init; } = [];
    internal PreviewLoadStatus                 Status       { get; init; }
    internal string?                           ErrorMessage { get; init; }
}
