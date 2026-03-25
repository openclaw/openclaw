using System.ComponentModel;
using System.Linq;
using OpenClawWindows.Domain.Nodes;
using OpenClawWindows.Presentation.Tray.Components;

namespace OpenClawWindows.Presentation.Tray;

/// <summary>
/// Nodes section in the tray menu: separator + gateway row + up to MaxVisibleNodes sorted
/// node rows wrapped in
/// MenuHighlightedHostView. Overflow collapsed to a "More Devices…" label.
/// </summary>
internal sealed partial class NodesMenuSection : UserControl, INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    // Tunables
    internal const int MaxVisibleNodes = 8; // entries.prefix(8) before "More Devices…"

    // ── Dependency properties ─────────────────────────────────────────────────

    public static readonly DependencyProperty NodesProperty =
        DependencyProperty.Register(nameof(Nodes), typeof(object), typeof(NodesMenuSection),
            new PropertyMetadata(null, (d, _) => ((NodesMenuSection)d).NotifyAll()));

    public static readonly DependencyProperty IsConnectedProperty =
        DependencyProperty.Register(nameof(IsConnected), typeof(bool), typeof(NodesMenuSection),
            new PropertyMetadata(false, (d, _) => ((NodesMenuSection)d).NotifyAll()));

    public static readonly DependencyProperty IsNodesLoadingProperty =
        DependencyProperty.Register(nameof(IsNodesLoading), typeof(bool), typeof(NodesMenuSection),
            new PropertyMetadata(false, (d, _) => ((NodesMenuSection)d).NotifyAll()));

    // Typed as object? — callers pass IReadOnlyList<NodeInfo>; avoids XAML type-info issues.
    public object? Nodes
    {
        get => GetValue(NodesProperty);
        set => SetValue(NodesProperty, value);
    }

    public bool IsConnected
    {
        get => (bool)GetValue(IsConnectedProperty);
        set => SetValue(IsConnectedProperty, value);
    }

    public bool IsNodesLoading
    {
        get => (bool)GetValue(IsNodesLoadingProperty);
        set => SetValue(IsNodesLoadingProperty, value);
    }

    public NodesMenuSection()
    {
        InitializeComponent();
    }

    // ── x:Bind sources ───────────────────────────────────────────────────────

    // not connected → [] (section hidden via IsConnected binding)
    // connected + loading → single placeholder row
    // connected + no nodes → single "No devices yet" placeholder
    // connected + nodes → gateway row + sorted entries + optional overflow
    public IReadOnlyList<NodesSectionRowVM> NodeRows
    {
        get
        {
            if (!IsConnected) return [];

            var nodes = Nodes as IReadOnlyList<NodeInfo> ?? [];

            if (IsNodesLoading && nodes.Count == 0)
                return [new NodesPlaceholderVM("Loading devices…")];

            var rows = new List<NodesSectionRowVM>();

            // Gateway entry first
            var gateway = nodes.FirstOrDefault(NodeMenuEntryFormatter.IsGateway);
            if (gateway is not null)
                rows.Add(new NodesNodeVM(gateway));

            // sortedNodeEntries(): connected non-gateway nodes, sorted by connected/paired/name/nodeId
            var entries = nodes
                .Where(n => !NodeMenuEntryFormatter.IsGateway(n) && n.IsConnected)
                .OrderByDescending(n => n.IsConnected)
                .ThenByDescending(n => n.IsPaired)
                .ThenBy(n => NodeMenuEntryFormatter.PrimaryName(n), StringComparer.OrdinalIgnoreCase)
                .ThenBy(n => n.NodeId, StringComparer.Ordinal)
                .ToList();

            foreach (var entry in entries.Take(MaxVisibleNodes))
                rows.Add(new NodesNodeVM(entry));

            // Mirror: if entries.count > 8 → show "More Devices…" label
            if (entries.Count > MaxVisibleNodes)
                rows.Add(new NodesOverflowVM("More Devices…"));

            if (rows.Count == 0)
                rows.Add(new NodesPlaceholderVM("No devices yet"));

            return rows;
        }
    }

    private void NotifyAll()
    {
        var h = PropertyChanged;
        if (h is null) return;
        h(this, new PropertyChangedEventArgs(nameof(IsConnected)));
        h(this, new PropertyChangedEventArgs(nameof(NodeRows)));
    }
}

// ── VM types for row discrimination ──────────────────────────────────────────
// Discriminated union consumed by NodesSectionTemplateSelector.

internal abstract record NodesSectionRowVM;

internal sealed record NodesPlaceholderVM(string Text) : NodesSectionRowVM;
internal sealed record NodesNodeVM(NodeInfo Node)      : NodesSectionRowVM;
internal sealed record NodesOverflowVM(string Text)    : NodesSectionRowVM;

// ── DataTemplateSelector ──────────────────────────────────────────────────────
// Routes each row VM to its matching DataTemplate in NodesMenuSection.xaml.

internal sealed class NodesSectionTemplateSelector : DataTemplateSelector
{
    public DataTemplate? PlaceholderTemplate { get; set; }
    public DataTemplate? NodeTemplate        { get; set; }
    public DataTemplate? OverflowTemplate    { get; set; }

    // WinUI3 ItemsControl calls the two-parameter overload; single-param is never invoked.
    protected override DataTemplate? SelectTemplateCore(object item, DependencyObject container)
        => item switch
        {
            NodesPlaceholderVM => PlaceholderTemplate,
            NodesNodeVM        => NodeTemplate,
            NodesOverflowVM    => OverflowTemplate,
            _                  => null
        };
}
