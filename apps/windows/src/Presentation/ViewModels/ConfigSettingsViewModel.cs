using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Infrastructure.Config;

namespace OpenClawWindows.Presentation.ViewModels;

/// <summary>
/// Manages the config schema, draft editing, and save/reload lifecycle for the
/// Config settings page.
/// </summary>
internal sealed partial class ConfigSettingsViewModel : ObservableObject
{
    // Tunables
    private const int SchemaTimeoutMs = 8000;

    private readonly IGatewayRpcChannel _rpc;
    private readonly IConfigStore _configStore;

    [ObservableProperty] private bool _configSchemaLoading;
    [ObservableProperty] private ConfigSchemaNode? _configSchema;
    [ObservableProperty] private bool _configDirty;
    [ObservableProperty] private bool _configLoaded;
    [ObservableProperty] private bool _isSavingConfig;
    [ObservableProperty] private string? _configStatus;

    // ── Selection state (moved from ConfigSettingsPage) ──────────────────────
    [ObservableProperty] private ObservableCollection<ConfigSectionVM> _sectionItems = [];
    [ObservableProperty] private ConfigSectionVM? _selectedSection;
    [ObservableProperty] private ObservableCollection<ConfigSubsectionVM> _subsectionItems = [];
    [ObservableProperty] private ConfigSubsectionVM? _selectedSubsection;  // null → "All"
    [ObservableProperty] private bool _isSubsectionAll;

    internal Dictionary<string, ConfigUiHint> ConfigUiHints { get; private set; } = [];
    internal Dictionary<string, object?> ConfigDraft { get; private set; } = [];
    private Dictionary<string, object?> _configRoot = [];

    // ── Computed properties for XAML bindings ────────────────────────────────
    internal bool HasStatus        => ConfigStatus is not null;
    internal bool HasActiveSection => SelectedSection is not null;
    internal bool HasSectionHelp   => SelectedSection?.Help is not null;
    internal bool HasSubsections   => SubsectionItems.Count > 0;
    internal string SaveLabel      => IsSavingConfig ? "Saving…" : "Save";
    internal bool CanSave          => !IsSavingConfig && ConfigDirty;

    public ConfigSettingsViewModel(IGatewayRpcChannel rpc, IConfigStore configStore)
    {
        _rpc = rpc;
        _configStore = configStore;
    }

    // Rebuilds section list when schema changes
    partial void OnConfigSchemaChanged(ConfigSchemaNode? value) => RebuildSectionItems();

    partial void OnIsSavingConfigChanged(bool value)
    {
        OnPropertyChanged(nameof(SaveLabel));
        OnPropertyChanged(nameof(CanSave));
    }

    partial void OnConfigDirtyChanged(bool value) => OnPropertyChanged(nameof(CanSave));

    partial void OnSelectedSectionChanged(ConfigSectionVM? value)
    {
        OnPropertyChanged(nameof(HasActiveSection));
        OnPropertyChanged(nameof(HasSectionHelp));
    }

    partial void OnConfigStatusChanged(string? value) => OnPropertyChanged(nameof(HasStatus));

    internal async Task LoadConfigSchemaAsync(CancellationToken ct = default)
    {
        if (ConfigSchemaLoading) return;
        ConfigSchemaLoading = true;
        try
        {
            var bytes = await _rpc.RequestRawAsync("config.schema", timeoutMs: SchemaTimeoutMs, ct: ct);
            using var doc = JsonDocument.Parse(bytes);
            if (doc.RootElement.TryGetProperty("schema", out var schemaEl))
                ConfigSchema = ConfigSchemaNode.Create(schemaEl.Clone());
            if (doc.RootElement.TryGetProperty("uihints", out var hintsEl))
                ConfigUiHints = ConfigSchemaFunctions.DecodeUiHints(hintsEl.Clone());
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ConfigStatus = ex.Message;
        }
        finally
        {
            ConfigSchemaLoading = false;
        }
    }

    internal async Task LoadConfigAsync(CancellationToken ct = default)
    {
        try
        {
            var root = await _configStore.LoadAsync(ct);
            _configRoot = root;
            ConfigDraft = DeepClone(root);
            ConfigDirty = false;
            ConfigLoaded = true;
            ConfigStatus = null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ConfigStatus = ex.Message;
        }
    }

    internal Task ReloadConfigDraftAsync(CancellationToken ct = default) => LoadConfigAsync(ct);

    internal async Task SaveConfigDraftAsync(CancellationToken ct = default)
    {
        if (IsSavingConfig) return;
        IsSavingConfig = true;
        try
        {
            await _configStore.SaveAsync(ConfigDraft, ct);
            await LoadConfigAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            ConfigStatus = ex.Message;
        }
        finally
        {
            IsSavingConfig = false;
        }
    }

    internal object? ConfigValueAt(IReadOnlyList<ConfigPathSegment> path)
    {
        if (ValueAtPath(ConfigDraft, path) is { } v) return v;
        // Channel config fallback: strip "channels/<id>" prefix
        if (path.Count >= 2
            && path[0] is ConfigPathSegment.Key { Value: "channels" }
            && path[1] is ConfigPathSegment.Key)
            return ValueAtPath(ConfigDraft, path.Skip(1).ToList());
        return null;
    }

    internal void UpdateConfigValue(IReadOnlyList<ConfigPathSegment> path, object? value)
    {
        object root = ConfigDraft;
        SetValueAtPath(ref root, path, value);
        ConfigDraft = root as Dictionary<string, object?> ?? ConfigDraft;
        ConfigDirty = true;
    }

    // ── Selection (moved from ConfigSettingsPage) ─────────────────────────────

    internal void SelectSection(ConfigSectionVM section)
    {
        if (SelectedSection?.Key == section.Key) return;
        SelectedSection = section;
        IsSubsectionAll = false;
        RebuildSubsectionItems();
        SelectedSubsection = SubsectionItems.Count > 0 ? SubsectionItems[0] : null;
    }

    internal void SelectSubsection(ConfigSubsectionVM sub)
    {
        foreach (var s in SubsectionItems) s.IsSelected = s == sub || (sub.IsAll && s.IsAll);
        SelectedSubsection = sub.IsAll ? null : sub;
        IsSubsectionAll = sub.IsAll;
    }

    private void RebuildSectionItems()
    {
        SectionItems.Clear();
        foreach (var s in ResolveSections())
            SectionItems.Add(s);
        EnsureSelection();
    }

    private void RebuildSubsectionItems()
    {
        SubsectionItems.Clear();
        if (SelectedSection is null)
        {
            OnPropertyChanged(nameof(HasSubsections));
            return;
        }
        var subs = ResolveSubsections(SelectedSection);
        if (subs.Count == 0)
        {
            OnPropertyChanged(nameof(HasSubsections));
            return;
        }
        SubsectionItems.Add(new ConfigSubsectionVM
        {
            Key   = "__all__",
            Label = "All",
            Help  = null,
            Node  = SelectedSection.Node,
            Path  = [new ConfigPathSegment.Key(SelectedSection.Key)],
            IsAll = true,
        });
        foreach (var s in subs)
            SubsectionItems.Add(s);
        OnPropertyChanged(nameof(HasSubsections));
    }

    private void EnsureSelection()
    {
        if (SectionItems.Count == 0) return;
        SelectedSection ??= SectionItems[0];
        if (!SectionItems.Contains(SelectedSection))
            SelectedSection = SectionItems[0];
        RebuildSubsectionItems();
        if (SubsectionItems.Count > 0 && SelectedSubsection is null)
            SelectedSubsection = SubsectionItems[0];
    }

    // ── Schema resolution (moved from ConfigSettingsPage) ────────────────────

    private IReadOnlyList<ConfigSectionVM> ResolveSections()
    {
        if (ConfigSchema is not { } schema) return [];
        var node  = ResolvedSchemaNode(schema);
        var hints = ConfigUiHints;

        return node.Properties.Keys
            .OrderBy(k =>
            {
                var p = new List<ConfigPathSegment> { new ConfigPathSegment.Key(k) };
                return ConfigSchemaFunctions.HintForPath(p, hints)?.Order ?? 0;
            })
            .ThenBy(k => k)
            .Select(k =>
            {
                if (!node.Properties.TryGetValue(k, out var child)) return null;
                var p    = new List<ConfigPathSegment> { new ConfigPathSegment.Key(k) };
                var hint = ConfigSchemaFunctions.HintForPath(p, hints);
                return new ConfigSectionVM(
                    key:   k,
                    label: hint?.Label ?? child.Title ?? Humanize(k),
                    help:  hint?.Help  ?? child.Description,
                    node:  child);
            })
            .Where(s => s is not null)
            .ToList()!;
    }

    private IReadOnlyList<ConfigSubsectionVM> ResolveSubsections(ConfigSectionVM section)
    {
        var node = ResolvedSchemaNode(section.Node);
        if (node.SchemaType != "object") return [];
        var hints = ConfigUiHints;

        return node.Properties.Keys
            .OrderBy(k =>
            {
                var p = new List<ConfigPathSegment>
                    { new ConfigPathSegment.Key(section.Key), new ConfigPathSegment.Key(k) };
                return ConfigSchemaFunctions.HintForPath(p, hints)?.Order ?? 0;
            })
            .ThenBy(k => k)
            .Select(k =>
            {
                if (!node.Properties.TryGetValue(k, out var child)) return null;
                var p    = new List<ConfigPathSegment>
                    { new ConfigPathSegment.Key(section.Key), new ConfigPathSegment.Key(k) };
                var hint = ConfigSchemaFunctions.HintForPath(p, hints);
                return new ConfigSubsectionVM
                {
                    Key   = k,
                    Label = hint?.Label ?? child.Title ?? Humanize(k),
                    Help  = hint?.Help  ?? child.Description,
                    Node  = child,
                    Path  = p,
                };
            })
            .Where(s => s is not null)
            .ToList()!;
    }

    // unwrap single non-null anyOf/oneOf variant
    internal static ConfigSchemaNode ResolvedSchemaNode(ConfigSchemaNode node)
    {
        var variants = node.AnyOf.Count == 0 ? node.OneOf : node.AnyOf;
        if (variants.Count == 0) return node;
        var nonNull = variants.Where(v => !v.IsNullSchema).ToList();
        return nonNull.Count == 1 ? nonNull[0] : node;
    }

    internal static string Humanize(string key) =>
        System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(
            key.Replace('_', ' ').Replace('-', ' '));

    // ── Path/value helpers ────────────────────────────────────────────────────

    private static object? ValueAtPath(Dictionary<string, object?> root, IReadOnlyList<ConfigPathSegment> path)
    {
        object? current = root;
        foreach (var seg in path)
        {
            current = seg switch
            {
                ConfigPathSegment.Key k when current is Dictionary<string, object?> d
                    => d.TryGetValue(k.Value, out var v) ? v : null,
                ConfigPathSegment.Index i when current is List<object?> l && i.Value < l.Count
                    => l[i.Value],
                _ => null
            };
            if (current is null) return null;
        }
        return current;
    }

    private static void SetValueAtPath(ref object root, IReadOnlyList<ConfigPathSegment> path, object? value)
    {
        if (path.Count == 0) return;
        switch (path[0])
        {
            case ConfigPathSegment.Key k:
            {
                var dict = root as Dictionary<string, object?> ?? [];
                if (path.Count == 1)
                {
                    if (value is null) dict.Remove(k.Value);
                    else dict[k.Value] = value;
                }
                else
                {
                    object child = dict.TryGetValue(k.Value, out var c)
                        ? c ?? new Dictionary<string, object?>()
                        : new Dictionary<string, object?>();
                    var tail = path.Skip(1).ToList();
                    SetValueAtPath(ref child, tail, value);
                    dict[k.Value] = child;
                }
                root = dict;
                break;
            }
            case ConfigPathSegment.Index i:
            {
                var list = root as List<object?> ?? [];
                while (list.Count <= i.Value) list.Add(null);
                if (path.Count == 1)
                {
                    if (value is null && i.Value < list.Count) list.RemoveAt(i.Value);
                    else if (i.Value < list.Count) list[i.Value] = value;
                }
                else
                {
                    object child = list[i.Value] ?? new Dictionary<string, object?>();
                    var tail = path.Skip(1).ToList();
                    SetValueAtPath(ref child, tail, value);
                    if (i.Value < list.Count) list[i.Value] = child;
                }
                root = list;
                break;
            }
        }
    }

    private static Dictionary<string, object?> DeepClone(Dictionary<string, object?> source)
    {
        var clone = new Dictionary<string, object?>(source.Count);
        foreach (var (k, v) in source)
            clone[k] = CloneValue(v);
        return clone;
    }

    private static object? CloneValue(object? value) => value switch
    {
        Dictionary<string, object?> d => DeepClone(d),
        List<object?> l               => l.Select(CloneValue).ToList<object?>(),
        null                           => null,
        _                              => value  // string, bool, long, double are immutable
    };
}

// ── Selection VMs ─────────────────────────────────────────────────────────────

internal sealed class ConfigSectionVM(string key, string label, string? help, ConfigSchemaNode node)
{
    internal string           Key   { get; } = key;
    internal string           Label { get; } = label;
    internal string?          Help  { get; } = help;
    internal ConfigSchemaNode Node  { get; } = node;
}

internal sealed class ConfigSubsectionVM : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    internal string           Key   { get; init; } = string.Empty;
    internal string           Label { get; init; } = string.Empty;
    internal string?          Help  { get; init; }
    internal ConfigSchemaNode Node  { get; init; } = null!;
    internal IReadOnlyList<ConfigPathSegment> Path { get; init; } = [];
    internal bool             IsAll { get; init; }

    private bool _isSelected;
    internal bool IsSelected
    {
        get => _isSelected;
        set
        {
            if (_isSelected == value) return;
            _isSelected = value;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(IsSelected)));
        }
    }
}
