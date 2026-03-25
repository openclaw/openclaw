using System.Text.Json;
using Microsoft.UI;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Infrastructure.Config;
using OpenClawWindows.Presentation.ViewModels;
using WinUIApplication = Microsoft.UI.Xaml.Application;

namespace OpenClawWindows.Presentation.Settings;

internal sealed partial class ConfigSchemaFormView : UserControl
{
    internal ConfigSettingsViewModel? ViewModel { get; set; }

    public ConfigSchemaFormView() { InitializeComponent(); }

    internal void RebuildForm()
    {
        FormRoot.Children.Clear();
        var vm = ViewModel;
        if (vm?.SelectedSection is not { } section) return;

        var defaultPath = new List<ConfigPathSegment> { new ConfigPathSegment.Key(section.Key) };
        ConfigSchemaNode schema;
        IReadOnlyList<ConfigPathSegment> path;

        if (!vm.IsSubsectionAll && vm.SelectedSubsection is { } sub)
        {
            schema = sub.Node;
            path   = sub.Path;
        }
        else
        {
            schema = ConfigSettingsViewModel.ResolvedSchemaNode(section.Node);
            path   = defaultPath;
        }

        FormRoot.Children.Add(BuildNode(schema, path));
    }

    // ── Schema form builder ──────────

    private StackPanel BuildNode(ConfigSchemaNode schema, IReadOnlyList<ConfigPathSegment> path)
    {
        var hints    = ViewModel?.ConfigUiHints ?? [];
        var label    = ConfigSchemaFunctions.HintForPath(path, hints)?.Label ?? schema.Title;
        var help     = ConfigSchemaFunctions.HintForPath(path, hints)?.Help  ?? schema.Description;
        var variants = schema.AnyOf.Count == 0 ? schema.OneOf : schema.AnyOf;

        // anyOf/oneOf: unwrap single non-null variant, or render as literal enum picker
        if (variants.Count > 0)
        {
            var nonNull = variants.Where(v => !v.IsNullSchema).ToList();
            if (nonNull.Count == 1)
                return BuildNode(nonNull[0], path);

            var literals = nonNull
                .Select(v => v.LiteralValue)
                .Where(v => v.HasValue)
                .Select(v => v!.Value)
                .ToList();
            if (literals.Count > 0 && literals.Count == nonNull.Count)
                return BuildEnumNode(literals, path, label, help, schema.ExplicitDefault);
        }

        return schema.SchemaType switch
        {
            "object"              => BuildObjectNode(schema, path, label, help),
            "array"               => BuildArrayNode(schema, path, label, help),
            "boolean"             => BuildBooleanNode(path, label, help, schema.ExplicitDefault),
            "number" or "integer" => BuildNumberNode(schema, path, label, help),
            "string"              => BuildStringNode(schema, path, label, help),
            _                     => BuildUnsupportedNode(label)
        };
    }

    // case "object"
    private StackPanel BuildObjectNode(
        ConfigSchemaNode schema, IReadOnlyList<ConfigPathSegment> path, string? label, string? help)
    {
        var panel = new StackPanel { Spacing = 12 };
        if (label is not null) panel.Children.Add(LabelBlock(label));
        if (help is not null)  panel.Children.Add(HelpBlock(help));

        var hints = ViewModel?.ConfigUiHints ?? [];
        var keys  = schema.Properties.Keys
            .OrderBy(k =>
            {
                var cp = path.Concat([new ConfigPathSegment.Key(k)]).ToList();
                return ConfigSchemaFunctions.HintForPath(cp, hints)?.Order ?? 0;
            })
            .ThenBy(k => k);

        foreach (var k in keys)
        {
            if (schema.Properties.TryGetValue(k, out var child))
            {
                var childPath = path.Concat([new ConfigPathSegment.Key(k)]).ToList();
                panel.Children.Add(BuildNode(child, childPath));
            }
        }

        if (schema.AllowsAdditionalProperties)
            panel.Children.Add(BuildAdditionalPropertiesNode(schema, path));

        return panel;
    }

    private StackPanel BuildArrayNode(
        ConfigSchemaNode schema, IReadOnlyList<ConfigPathSegment> path, string? label, string? help)
    {
        var panel = new StackPanel { Spacing = 10 };
        if (label is not null) panel.Children.Add(LabelBlock(label));
        if (help is not null)  panel.Children.Add(HelpBlock(help));

        var items      = (ViewModel?.ConfigValueAt(path) as List<object?>) ?? [];
        var itemSchema = schema.Items;

        for (var i = 0; i < items.Count; i++)
        {
            var index = i;
            var row   = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            if (itemSchema is not null)
            {
                var itemPath = path.Concat([new ConfigPathSegment.Index(index)]).ToList();
                row.Children.Add(BuildNode(itemSchema, itemPath));
            }
            else
            {
                row.Children.Add(new TextBlock
                    { Text = items[i]?.ToString() ?? "", VerticalAlignment = VerticalAlignment.Center });
            }
            var removeBtn = new Button { Content = "Remove", FontSize = 11 };
            removeBtn.Click += (_, _) =>
            {
                var current = (ViewModel?.ConfigValueAt(path) as List<object?>) ?? [];
                var next    = new List<object?>(current);
                next.RemoveAt(index);
                ViewModel?.UpdateConfigValue(path, next);
                RebuildForm();
            };
            row.Children.Add(removeBtn);
            panel.Children.Add(row);
        }

        var addBtn = new Button { Content = "Add", FontSize = 11 };
        addBtn.Click += (_, _) =>
        {
            var current = (ViewModel?.ConfigValueAt(path) as List<object?>) ?? [];
            var next    = new List<object?>(current) { ItemDefaultValue(itemSchema) };
            ViewModel?.UpdateConfigValue(path, next);
            RebuildForm();
        };
        panel.Children.Add(addBtn);
        return panel;
    }

    // case "boolean"
    private StackPanel BuildBooleanNode(
        IReadOnlyList<ConfigPathSegment> path, string? label, string? help, JsonElement? explicitDefault)
    {
        var panel   = new StackPanel { Spacing = 4 };
        var defBool = explicitDefault is { ValueKind: JsonValueKind.True } or { ValueKind: JsonValueKind.False }
            ? explicitDefault.Value.GetBoolean()
            : (bool?)null;
        var current = ViewModel?.ConfigValueAt(path) as bool? ?? defBool ?? false;

        var toggle = new ToggleSwitch
        {
            IsOn       = current,
            OnContent  = label ?? "Enabled",
            OffContent = label ?? "Enabled"
        };
        toggle.Toggled += (_, _) => ViewModel?.UpdateConfigValue(path, toggle.IsOn);
        panel.Children.Add(toggle);
        if (help is not null) panel.Children.Add(HelpBlock(help));
        return panel;
    }

    private StackPanel BuildNumberNode(
        ConfigSchemaNode schema, IReadOnlyList<ConfigPathSegment> path, string? label, string? help)
    {
        var panel   = new StackPanel { Spacing = 6 };
        if (label is not null) panel.Children.Add(LabelBlock(label));
        if (help is not null)  panel.Children.Add(HelpBlock(help));

        var isInt       = schema.SchemaType == "integer";
        var currentRaw  = ViewModel?.ConfigValueAt(path);
        var currentText = currentRaw is not null ? Convert.ToString(currentRaw) ?? "" : "";

        var box = new TextBox { Text = currentText, PlaceholderText = isInt ? "0" : "0.0" };
        box.LostFocus += (_, _) =>
        {
            var trimmed = box.Text.Trim();
            if (string.IsNullOrEmpty(trimmed)) { ViewModel?.UpdateConfigValue(path, null); return; }
            if (double.TryParse(trimmed, System.Globalization.NumberStyles.Any,
                    System.Globalization.CultureInfo.InvariantCulture, out var d))
                ViewModel?.UpdateConfigValue(path, isInt ? (object)(long)d : d);
        };
        panel.Children.Add(box);
        return panel;
    }

    private StackPanel BuildStringNode(
        ConfigSchemaNode schema, IReadOnlyList<ConfigPathSegment> path, string? label, string? help)
    {
        var panel = new StackPanel { Spacing = 6 };
        if (label is not null) panel.Children.Add(LabelBlock(label));
        if (help is not null)  panel.Children.Add(HelpBlock(help));

        var hints       = ViewModel?.ConfigUiHints ?? [];
        var hint        = ConfigSchemaFunctions.HintForPath(path, hints);
        var sensitive   = hint?.Sensitive ?? ConfigSchemaFunctions.IsSensitivePath(path);
        var placeholder = hint?.Placeholder ?? "";
        var strDefault  = schema.ExplicitDefault is { ValueKind: JsonValueKind.String } jd
            ? jd.GetString()
            : null;
        var current = ViewModel?.ConfigValueAt(path) as string ?? strDefault ?? "";

        if (schema.EnumValues is { } enumEl)
        {
            var options = enumEl.EnumerateArray().Select(e => e.ToString()).ToList();
            var combo   = new ComboBox { ItemsSource = options, SelectedItem = current };
            combo.SelectionChanged += (_, _) => ViewModel?.UpdateConfigValue(path, combo.SelectedItem as string);
            panel.Children.Add(combo);
            return panel;
        }

        if (sensitive)
        {
            var pwd = new PasswordBox { Password = current, PlaceholderText = placeholder };
            pwd.PasswordChanged += (_, _) =>
            {
                var v = pwd.Password.Trim();
                ViewModel?.UpdateConfigValue(path, string.IsNullOrEmpty(v) ? null : v);
            };
            panel.Children.Add(pwd);
        }
        else
        {
            var box = new TextBox { Text = current, PlaceholderText = placeholder };
            box.LostFocus += (_, _) =>
            {
                var v = box.Text.Trim();
                ViewModel?.UpdateConfigValue(path, string.IsNullOrEmpty(v) ? null : v);
            };
            panel.Children.Add(box);
        }
        return panel;
    }

    private StackPanel BuildEnumNode(
        List<JsonElement> literals, IReadOnlyList<ConfigPathSegment> path,
        string? label, string? help, JsonElement? explicitDefault)
    {
        var panel = new StackPanel { Spacing = 6 };
        if (label is not null) panel.Children.Add(LabelBlock(label));
        if (help is not null)  panel.Children.Add(HelpBlock(help));

        var current    = ViewModel?.ConfigValueAt(path);
        var currentStr = current?.ToString()
            ?? (explicitDefault?.ToString())
            ?? "";
        var options = literals.Select(l => l.ToString()).ToList();

        var combo = new ComboBox { ItemsSource = options, SelectedItem = currentStr };
        combo.SelectionChanged += (_, _) =>
        {
            var idx = combo.SelectedIndex;
            if (idx < 0 || idx >= literals.Count) { ViewModel?.UpdateConfigValue(path, null); return; }
            // Store as C# value matching JSON type
            ViewModel?.UpdateConfigValue(path, JsonElementToValue(literals[idx]));
        };
        panel.Children.Add(combo);
        return panel;
    }

    private StackPanel BuildAdditionalPropertiesNode(ConfigSchemaNode schema, IReadOnlyList<ConfigPathSegment> path)
    {
        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(LabelBlock("Extra entries"));

        if (schema.AdditionalProperties is not { } additionalSchema) return panel;

        var dict     = (ViewModel?.ConfigValueAt(path) as Dictionary<string, object?>) ?? [];
        var reserved = new HashSet<string>(schema.Properties.Keys);
        var extras   = dict.Keys.Where(k => !reserved.Contains(k)).OrderBy(k => k).ToList();

        if (extras.Count == 0)
        {
            panel.Children.Add(new TextBlock
            {
                Text = "No extra entries yet.",
                FontSize = 12,
                Foreground = ResourceBrush("TextFillColorSecondaryBrush")
            });
        }
        else
        {
            foreach (var key in extras)
            {
                var k        = key;
                var itemPath = path.Concat([new ConfigPathSegment.Key(k)]).ToList();
                var row      = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };

                var keyBox = new TextBox { Text = k, Width = 160, PlaceholderText = "Key" };
                keyBox.LostFocus += (_, _) =>
                {
                    var newKey = keyBox.Text.Trim();
                    if (string.IsNullOrEmpty(newKey) || newKey == k) return;
                    var current = (ViewModel?.ConfigValueAt(path) as Dictionary<string, object?>) ?? [];
                    if (current.ContainsKey(newKey)) return;
                    var next = new Dictionary<string, object?>(current) { [newKey] = current.GetValueOrDefault(k) };
                    next.Remove(k);
                    ViewModel?.UpdateConfigValue(path, next);
                    RebuildForm();
                };
                row.Children.Add(keyBox);
                row.Children.Add(BuildNode(additionalSchema, itemPath));

                var removeBtn = new Button { Content = "Remove", FontSize = 11 };
                removeBtn.Click += (_, _) =>
                {
                    var current = (ViewModel?.ConfigValueAt(path) as Dictionary<string, object?>) ?? [];
                    var next    = new Dictionary<string, object?>(current);
                    next.Remove(k);
                    ViewModel?.UpdateConfigValue(path, next);
                    RebuildForm();
                };
                row.Children.Add(removeBtn);
                panel.Children.Add(row);
            }
        }

        var addBtn = new Button { Content = "Add", FontSize = 11 };
        addBtn.Click += (_, _) =>
        {
            var current = (ViewModel?.ConfigValueAt(path) as Dictionary<string, object?>) ?? [];
            var next    = new Dictionary<string, object?>(current);
            var idx     = 1;
            var newKey  = $"new-{idx}";
            while (next.ContainsKey(newKey)) newKey = $"new-{++idx}";
            next[newKey] = ItemDefaultValue(additionalSchema);
            ViewModel?.UpdateConfigValue(path, next);
            RebuildForm();
        };
        panel.Children.Add(addBtn);
        return panel;
    }

    private static StackPanel BuildUnsupportedNode(string? label)
    {
        var panel = new StackPanel { Spacing = 6 };
        if (label is not null) panel.Children.Add(LabelBlock(label));
        panel.Children.Add(new TextBlock
        {
            Text = "Unsupported field type.",
            FontSize = 12,
            Foreground = ResourceBrush("TextFillColorSecondaryBrush")
        });
        return panel;
    }

    // ── UIElement / resource helpers ─────────────────────────────────────────

    private static TextBlock LabelBlock(string text) => new()
    {
        Text       = text,
        FontSize   = 14,
        FontWeight = Microsoft.UI.Text.FontWeights.SemiBold
    };

    private static TextBlock HelpBlock(string text) => new()
    {
        Text         = text,
        FontSize     = 12,
        Foreground   = ResourceBrush("TextFillColorSecondaryBrush"),
        TextWrapping = TextWrapping.Wrap
    };

    private static Brush ResourceBrush(string key)
    {
        try { return (Brush)WinUIApplication.Current.Resources[key]; }
        catch { return new SolidColorBrush(Colors.Gray); }
    }

    // Default value for a new array item or additional-property entry
    private static object? ItemDefaultValue(ConfigSchemaNode? schema) => schema?.SchemaType switch
    {
        "object"  => new Dictionary<string, object?>(),
        "array"   => new List<object?>(),
        "boolean" => (object?)false,
        "integer" => (object?)0L,
        "number"  => (object?)0.0,
        _         => string.Empty
    };

    // Convert a JsonElement literal to the matching C# value for storage
    private static object? JsonElementToValue(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.String  => el.GetString(),
        JsonValueKind.Number  => el.TryGetInt64(out var i) ? (object)i : el.GetDouble(),
        JsonValueKind.True    => (object)true,
        JsonValueKind.False   => (object)false,
        JsonValueKind.Null    => null,
        _                     => el.ToString()
    };
}
