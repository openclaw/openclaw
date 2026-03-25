using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using OpenClawWindows.Presentation.ViewModels;
using WinUIApplication = Microsoft.UI.Xaml.Application;

namespace OpenClawWindows.Presentation.Settings;

/// <summary>
/// Schema-driven config editor. Sidebar binds to ViewModel.SectionItems; detail panel
/// is XAML-declarative with x:Bind. ConfigSchemaFormView handles the recursive schema form.
/// </summary>
internal sealed partial class ConfigSettingsPage : Page
{
    internal ConfigSettingsViewModel? ViewModel { get; private set; }

    public ConfigSettingsPage() { InitializeComponent(); }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        ViewModel = e.Parameter as ConfigSettingsViewModel;
        if (ViewModel is null) return;
        ViewModel.PropertyChanged += OnVmPropertyChanged;
        SchemaForm.ViewModel = ViewModel;
        _ = InitAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        if (ViewModel is not null)
            ViewModel.PropertyChanged -= OnVmPropertyChanged;
    }

    private async Task InitAsync()
    {
        if (ViewModel is null) return;
        await ViewModel.LoadConfigSchemaAsync();
        await ViewModel.LoadConfigAsync();
        SchemaForm.RebuildForm();
    }

    private void OnVmPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        // Rebuild the schema form when selection or schema changes
        if (e.PropertyName is nameof(ConfigSettingsViewModel.SelectedSection)
                           or nameof(ConfigSettingsViewModel.SelectedSubsection)
                           or nameof(ConfigSettingsViewModel.ConfigSchema))
            DispatcherQueue.TryEnqueue(() => SchemaForm.RebuildForm());
    }

    private void SectionList_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (e.AddedItems.Count > 0 && e.AddedItems[0] is ConfigSectionVM section)
            ViewModel?.SelectSection(section);
    }

    private void SubsectionPill_Click(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Tag: ConfigSubsectionVM sub })
            ViewModel?.SelectSubsection(sub);
    }

    private async void Reload_Click(object sender, RoutedEventArgs e)
    {
        if (ViewModel is null) return;
        await ViewModel.ReloadConfigDraftAsync();
        SchemaForm.RebuildForm();
    }

    private async void Save_Click(object sender, RoutedEventArgs e)
        => await ViewModel?.SaveConfigDraftAsync()!;

    // ── x:Bind static helpers ─────────────────────────────────────────────────

    public static Visibility HelpVisibility(string? help)
        => help is not null ? Visibility.Visible : Visibility.Collapsed;

    public static Brush PillBackground(bool isSelected)
        => isSelected
            ? (Brush)WinUIApplication.Current.Resources["AccentFillColorTertiaryBrush"]
            : (Brush)WinUIApplication.Current.Resources["ControlFillColorDefaultBrush"];

    public static Brush PillForeground(bool isSelected)
        => isSelected
            ? (Brush)WinUIApplication.Current.Resources["AccentTextFillColorPrimaryBrush"]
            : (Brush)WinUIApplication.Current.Resources["TextFillColorPrimaryBrush"];
}
