using System.Text.Json;
using OpenClawWindows.Application.Onboarding;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Config;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Presentation.ViewModels;

/// <summary>
/// Drives the gateway-powered setup wizard.
/// </summary>
internal sealed partial class OnboardingViewModel : ObservableObject
{
    private readonly IGatewayRpcChannel   _rpc;
    private readonly ISettingsRepository  _settings;

    // Tunables
    private const int WizardStartTimeoutMs = 30_000;
    private const int WizardNextTimeoutMs  = 60_000;
    private const int MaxRestartAttempts   = 1;

    private string? _sessionId;
    private int     _restartAttempts;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowStepContent), nameof(StepType), nameof(StepTitle),
        nameof(StepMessage), nameof(StepPlaceholder), nameof(IsSensitive), nameof(SubmitButtonTitle),
        nameof(ShowTextInput), nameof(ShowPasswordInput), nameof(ShowConfirmInput),
        nameof(ShowSelectInput), nameof(ShowMultiselectInput), nameof(ShowProgressInput))]
    private WizardStepDto? _currentStep;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit), nameof(ShowLoading))]
    private bool _isStarting;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanSubmit))]
    private bool _isSubmitting;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowError))]
    private string? _errorMessage;

    [ObservableProperty] private bool   _isComplete;
    [ObservableProperty] private string _textInput    = string.Empty;
    [ObservableProperty] private string _passwordInput = string.Empty; // password-masked equivalent of TextInput
    [ObservableProperty] private bool   _confirmInput;
    [ObservableProperty] private int    _selectedOptionIndex;

    // Exposed for RadioButton / CheckBox ItemsControls
    public System.Collections.ObjectModel.ObservableCollection<WizardOptionItem> OptionItems { get; } = [];

    // ── Computed display helpers ──────────────────────────────────────────────

    public string  StepType        => _currentStep?.Type  ?? "";
    public string  StepTitle       => _currentStep?.Title ?? "Setup Wizard";
    public string? StepMessage     => _currentStep?.Message;
    public string? StepPlaceholder => _currentStep?.Placeholder;
    public bool    IsSensitive     => _currentStep?.Sensitive == true;

    public bool ShowStepContent      => _currentStep is not null && !_isStarting && !_isComplete;
    public bool ShowLoading          => _isStarting;
    public bool ShowError            => _errorMessage is not null;

    // Step-type visibility properties — drive Visibility converters in XAML.
    public bool ShowTextInput        => StepType is "text" && !IsSensitive;
    public bool ShowPasswordInput    => StepType is "text" && IsSensitive;
    public bool ShowConfirmInput     => StepType is "confirm";
    public bool ShowSelectInput      => StepType is "select";
    public bool ShowMultiselectInput => StepType is "multiselect";
    public bool ShowProgressInput    => StepType is "progress";

    public bool CanSubmit          => !_isStarting && !_isSubmitting && _currentStep is not null;
    public string SubmitButtonTitle => StepType is "action" ? "Run" : "Continue";

    // ── Construction ─────────────────────────────────────────────────────────

    public OnboardingViewModel(IGatewayRpcChannel rpc, ISettingsRepository settings)
    {
        _rpc      = rpc;
        _settings = settings;
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    // Called by OnboardingWizard when it opens. Idempotent — no-ops if already running.
    internal async Task StartAsync(CancellationToken ct = default)
    {
        if (_sessionId is not null || IsStarting) return;

        // Show loading spinner immediately
        // which shows a ProgressView on the wizard page while the skip check runs.
        IsStarting = true;
        ErrorMessage = null;

        if (await ShouldSkipAsync(ct))
        {
            IsStarting = false;
            var alreadyComplete = IsComplete;
            IsComplete = true;
            // Re-fire only on re-entry (IsComplete was already true): SetProperty is a no-op
            // when the value doesn't change, so auto-advance and CanGoNext binding miss the update.
            // Do NOT fire when IsComplete transitions false→true — SetProperty already fires once,
            // and a second fire would post a second GoNext dispatch → double-advance → premature Finish.
            if (alreadyComplete) OnPropertyChanged(nameof(IsComplete));
            return;
        }

        _restartAttempts = 0;

        try
        {
            var settings  = await _settings.LoadAsync(ct);
            var workspace = string.IsNullOrWhiteSpace(settings.WorkspacePath) ? null : settings.WorkspacePath;
            var result    = await _rpc.WizardStartAsync(workspace, WizardStartTimeoutMs, ct);
            ApplyStartResult(result);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            ErrorMessage = ex.Message;
        }
        finally
        {
            IsStarting = false;
        }
    }

    [RelayCommand(CanExecute = nameof(CanSubmit))]
    private async Task SubmitStep()
    {
        if (_sessionId is null || _currentStep is null) return;

        IsSubmitting = true;
        ErrorMessage = null;
        var step = _currentStep;

        try
        {
            var value  = BuildSubmitValue(step);
            var result = await _rpc.WizardNextAsync(_sessionId, step.Id, value, WizardNextTimeoutMs);
            ApplyNextResult(result);
        }
        catch (Exception ex)
        {
            // Restart if session was lost.
            if (IsSessionLostError(ex) && _restartAttempts < MaxRestartAttempts)
            {
                _restartAttempts++;
                _sessionId   = null;
                CurrentStep  = null;
                ErrorMessage = "Wizard session lost. Restarting…";
                await StartAsync();
                return;
            }

            ErrorMessage = ex.Message;
        }
        finally
        {
            IsSubmitting = false;
        }
    }

    [RelayCommand]
    private async Task Retry()
    {
        Reset();
        await StartAsync();
    }

    internal async Task CancelAsync(CancellationToken ct = default)
    {
        if (_sessionId is not null)
        {
            try { await _rpc.WizardCancelAsync(_sessionId, ct); }
            catch { /* best-effort */ }
        }
        // Always reset — covers the IsStarting=true case (WizardStart RPC in flight but no
        // session yet). Without this, GoBack from Wizard leaves IsStarting=true and re-entry
        // returns immediately, leaving the page permanently blank.
        Reset();
    }

    // ── Result application ────────────────────────────────────────────────────

    private void ApplyStartResult(WizardStartRpcResult result)
    {
        _sessionId   = result.SessionId;
        ErrorMessage = result.Error;
        ApplyStep(result.Step);

        if (result.Done || result.Status is "done")
        {
            IsComplete = true;
            _sessionId = null;
        }
        _restartAttempts = 0;
    }

    private void ApplyNextResult(WizardNextRpcResult result)
    {
        ErrorMessage = result.Error;
        ApplyStep(result.Step);

        if (result.Done || result.Status is "done" or "cancelled" or "error")
        {
            if (result.Done || result.Status is "done") IsComplete = true;
            _sessionId = null;
        }
    }

    private void ApplyStep(WizardStepDto? step)
    {
        CurrentStep  = step;
        if (step is null) return;

        TextInput    = step.InitialValueString;
        PasswordInput = step.InitialValueString;
        ConfirmInput = step.InitialValueBool;

        OptionItems.Clear();
        SelectedOptionIndex = 0;
        for (var i = 0; i < step.Options.Count; i++)
            OptionItems.Add(new WizardOptionItem(i, step.Options[i].Label, step.Options[i].Hint));
    }

    // ── Submit value builder ──────────────────────────────────────────────────

    private JsonElement? BuildSubmitValue(WizardStepDto step)
    {
        return step.Type switch
        {
            "text"        => ToJsonElement(IsSensitive ? PasswordInput : TextInput),
            "confirm"     => ToJsonElement(ConfirmInput),
            "select"      => SelectedOptionIndex < step.Options.Count
                                ? step.Options[SelectedOptionIndex].Value
                                : null,
            "multiselect" => BuildMultiselectValue(step),
            "action"      => ToJsonElement(true),
            _             => null,
        };
    }

    private JsonElement? BuildMultiselectValue(WizardStepDto step)
    {
        var values = OptionItems
            .Where(o => o.IsSelected && o.Index < step.Options.Count)
            .Select(o => step.Options[o.Index].Value)
            .Where(v => v.HasValue)
            .Select(v => v!.Value.GetRawText())
            .ToArray();

        // Serialize as JSON array of raw JSON values.
        var arrayJson = "[" + string.Join(",", values) + "]";
        using var doc = JsonDocument.Parse(arrayJson);
        return doc.RootElement.Clone();
    }

    private static JsonElement? ToJsonElement(string value)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(value));
        return doc.RootElement.Clone();
    }

    private static JsonElement? ToJsonElement(bool value)
    {
        using var doc = JsonDocument.Parse(value ? "true" : "false");
        return doc.RootElement.Clone();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    // skip if already onboarded, already configured,
    // or the gateway config file already has credentials (auth token/mode/password or wizard section).
    private async Task<bool> ShouldSkipAsync(CancellationToken ct)
    {
        try
        {
            var s = await _settings.LoadAsync(ct);
            return s.OnboardingSeen
                || s.ConnectionMode != ConnectionMode.Unconfigured
                || OpenClawConfigFile.ShouldSkipWizard();
        }
        catch { return false; }
    }

    private void Reset()
    {
        _sessionId        = null;
        _restartAttempts  = 0;
        CurrentStep       = null;
        ErrorMessage      = null;
        IsStarting        = false;
        IsSubmitting      = false;
        IsComplete        = false;
        TextInput         = string.Empty;
        PasswordInput     = string.Empty;
        ConfirmInput      = false;
        SelectedOptionIndex = 0;
        OptionItems.Clear();
    }

    private static bool IsSessionLostError(Exception ex)
    {
        var msg = ex.Message.ToLowerInvariant();
        return msg.Contains("wizard not found") || msg.Contains("wizard not running");
    }
}

// Observable wrapper for a wizard option — used for RadioButton / CheckBox ItemsControls.
internal sealed partial class WizardOptionItem : ObservableObject
{
    public int     Index { get; }
    public string  Label { get; }
    public string? Hint  { get; }

    [ObservableProperty] private bool _isSelected;

    internal WizardOptionItem(int index, string label, string? hint)
    {
        Index = index;
        Label = label;
        Hint  = hint;
    }
}
