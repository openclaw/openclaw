using System.Collections.ObjectModel;
using OpenClawWindows.Application.Skills;
using OpenClawWindows.Domain.Skills;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class SkillsSettingsViewModel : ObservableObject
{
    private readonly ISender _sender;
    private readonly HashSet<string> _busySkills = [];

    public ObservableCollection<SkillItem> Skills { get; } = [];

    [ObservableProperty]
    private bool _isLoading;

    [ObservableProperty]
    private string? _lastError;

    [ObservableProperty]
    private string? _statusMessage;

    public SkillsSettingsViewModel(ISender sender)
    {
        _sender = sender;
    }

    public bool IsBusy(string skillKey) => _busySkills.Contains(skillKey);

    [RelayCommand]
    private async Task RefreshAsync()
    {
        if (IsLoading) return;

        IsLoading  = true;
        LastError  = null;
        try
        {
            var result = await _sender.Send(new ListSkillsQuery());
            if (result.IsError)
            {
                LastError = result.FirstError.Description;
                return;
            }

            Skills.Clear();
            foreach (var s in result.Value)
                Skills.Add(SkillItem.From(s));

            if (!result.Value.Any())
                StatusMessage = "No skills reported yet.";
            else
                StatusMessage = null;
        }
        finally
        {
            IsLoading = false;
        }
    }

    [RelayCommand]
    private async Task ToggleEnabledAsync(SkillItem item)
    {
        await WithBusyAsync(item.SkillKey, async () =>
        {
            var result = await _sender.Send(new SetSkillEnabledCommand(item.SkillKey, !item.IsEnabled));
            StatusMessage = result.IsError
                ? result.FirstError.Description
                : !item.IsEnabled ? "Skill enabled" : "Skill disabled";
        });
    }

    [RelayCommand]
    private async Task InstallAsync(InstallArgs args)
    {
        await WithBusyAsync(args.SkillKey, async () =>
        {
            var result = await _sender.Send(new InstallSkillCommand(args.SkillName, args.InstallId));
            StatusMessage = result.IsError
                ? result.FirstError.Description
                : result.Value.Message;
        });
    }

    [RelayCommand]
    private async Task SetEnvAsync(SetEnvArgs args)
    {
        await WithBusyAsync(args.SkillKey, async () =>
        {
            var result = await _sender.Send(
                new SetSkillEnvCommand(args.SkillKey, args.EnvKey, args.Value, args.IsPrimary));
            StatusMessage = result.IsError
                ? result.FirstError.Description
                : args.IsPrimary ? "Saved API key" : $"Saved {args.EnvKey}";
        });
    }

    private async Task WithBusyAsync(string skillKey, Func<Task> work)
    {
        _busySkills.Add(skillKey);
        try
        {
            await work();
            await RefreshCommand.ExecuteAsync(null);
        }
        finally
        {
            _busySkills.Remove(skillKey);
        }
    }

    // ── DTOs passed to RelayCommands (XAML binds them as command parameters) ──

    public sealed record InstallArgs(string SkillKey, string SkillName, string InstallId);
    public sealed record SetEnvArgs(string SkillKey, string EnvKey, string Value, bool IsPrimary);

    // ── View row — property names match XAML bindings (Name, Description, IsEnabled) ──
    public sealed record SkillItem(
        string SkillKey,
        string Name,
        string Description,
        bool IsEnabled,
        string? Emoji,
        string Source,
        IReadOnlyList<string> MissingBins,
        IReadOnlyList<string> MissingEnv,
        IReadOnlyList<SkillInstallOption> InstallOptions)
    {
        internal static SkillItem From(SkillStatus s) =>
            new(
                s.SkillKey,
                s.Name,
                s.Description,
                !s.Disabled,
                s.Emoji,
                s.Source,
                s.Missing.Bins,
                s.Missing.Env,
                s.Install);
    }
}
