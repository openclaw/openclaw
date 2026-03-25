using System.ComponentModel;
using System.Linq;
using OpenClawWindows.Domain.Sessions;

namespace OpenClawWindows.Presentation.Tray.Components;

// barHeight is 3 (vs 6 in SessionMenuLabelView) so the card stays compact.
internal sealed partial class ContextMenuCardView : UserControl, INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    // ── Dependency properties ─────────────────────────────────────────────────

    public static readonly DependencyProperty RowsProperty =
        DependencyProperty.Register(nameof(Rows), typeof(object), typeof(ContextMenuCardView),
            new PropertyMetadata(null, (d, _) => ((ContextMenuCardView)d).NotifyAll()));

    public static readonly DependencyProperty StatusTextProperty =
        DependencyProperty.Register(nameof(StatusText), typeof(string), typeof(ContextMenuCardView),
            new PropertyMetadata(null, (d, _) => ((ContextMenuCardView)d).NotifyAll()));

    public static readonly DependencyProperty IsLoadingProperty =
        DependencyProperty.Register(nameof(IsLoading), typeof(bool), typeof(ContextMenuCardView),
            new PropertyMetadata(false, (d, _) => ((ContextMenuCardView)d).NotifyAll()));

    public object? Rows
    {
        get => GetValue(RowsProperty);
        set => SetValue(RowsProperty, value);
    }

    public string? StatusText
    {
        get => (string?)GetValue(StatusTextProperty);
        set => SetValue(StatusTextProperty, value);
    }

    public bool IsLoading
    {
        get => (bool)GetValue(IsLoadingProperty);
        set => SetValue(IsLoadingProperty, value);
    }

    public ContextMenuCardView()
    {
        InitializeComponent();
    }

    // ── x:Bind sources ───────────────────────────────────────────────────────

    public string SubtitleText
    {
        get
        {
            var rows = Rows as IReadOnlyList<SessionRow> ?? [];
            if (IsLoading || rows.Count == 0) return string.Empty;
            var windowHours = (int)Math.Round(MenuContextCardInjector.ActiveWindow.TotalHours);
            return $"{rows.Count} session{(rows.Count == 1 ? "" : "s")} · {windowHours}h";
        }
    }

    public bool HasStatusText => !IsLoading && !string.IsNullOrEmpty(StatusText);

    public bool IsEmpty
    {
        get
        {
            var rows = Rows as IReadOnlyList<SessionRow> ?? [];
            return !IsLoading && rows.Count == 0;
        }
    }

    public bool HasRows
    {
        get
        {
            var rows = Rows as IReadOnlyList<SessionRow> ?? [];
            return !IsLoading && rows.Count > 0;
        }
    }

    // Pre-computes display values per row so the DataTemplate is purely declarative.
    public IReadOnlyList<ContextMenuRowVM> SessionRows
    {
        get
        {
            var rows = Rows as IReadOnlyList<SessionRow> ?? [];
            return rows.Select(row => new ContextMenuRowVM(
                row.TotalTokens,
                row.ContextTokens,
                row.Label,
                row.Key == "main",
                $"{row.ContextSummaryShort} · {row.AgeText}")).ToArray();
        }
    }

    private void NotifyAll()
    {
        var h = PropertyChanged;
        if (h is null) return;
        h(this, new PropertyChangedEventArgs(nameof(SubtitleText)));
        h(this, new PropertyChangedEventArgs(nameof(HasStatusText)));
        h(this, new PropertyChangedEventArgs(nameof(IsEmpty)));
        h(this, new PropertyChangedEventArgs(nameof(HasRows)));
        h(this, new PropertyChangedEventArgs(nameof(SessionRows)));
    }
}

// ── Display view-model for one session row ────────────────────────────────────
// Pre-computed by ContextMenuCardView so the DataTemplate is purely declarative.

internal sealed record ContextMenuRowVM(
    int    TotalTokens,
    int    ContextTokens,
    string Label,
    bool   IsMain,
    string Summary);
