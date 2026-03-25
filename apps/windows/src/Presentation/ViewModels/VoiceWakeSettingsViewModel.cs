using System.Collections.ObjectModel;
using System.Globalization;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Settings;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.Settings;
using Windows.Devices.Enumeration;
using Windows.Media.Devices;
using Windows.Media.SpeechRecognition;

namespace OpenClawWindows.Presentation.ViewModels;

internal sealed partial class VoiceWakeSettingsViewModel : ObservableObject
{
    private readonly ISender                   _sender;
    private readonly IVoiceWakeTesterService?  _tester;
    private          AppSettings?              _current;
    private          CancellationTokenSource?  _testTimeoutCts;

    // Tunables
    private const int TestTimeoutMs      = 10_000;
    private const int FinalizeCleanupMs  = 2_000;

    // ── Test card state

    [ObservableProperty] private VoiceWakeTestState _testState = VoiceWakeTestState.Idle.Instance;
    [ObservableProperty] private bool               _isTesting;

    // ── Settings fields ───────────────────────────────────────────────────────

    [ObservableProperty] private bool   _voiceWakeEnabled;
    [ObservableProperty] private bool   _voicePushToTalkEnabled;
    [ObservableProperty] private double _sensitivity = 0.5;
    [ObservableProperty] private string _newTriggerWord = string.Empty;
    [ObservableProperty] private string? _lastError;

    // ── Picker selections ─────────────────────────────────────────────────────

    [ObservableProperty] private int _selectedMicIndex;
    [ObservableProperty] private int _selectedLocaleIndex;
    [ObservableProperty] private int _selectedTriggerChimeIndex;
    [ObservableProperty] private int _selectedSendChimeIndex;

    // ── Observable collections for pickers ───────────────────────────────────

    public ObservableCollection<MicOption>    AvailableMics    { get; } = [];
    public ObservableCollection<LocaleOption> AvailableLocales { get; } = [];
    public ObservableCollection<string>       TriggerWords     { get; } = [];

    // Chime names mirror macOS VoiceWakeChime options (stored as plain strings in AppSettings).
    public List<string> AvailableChimes { get; } =
    [
        "None", "Glass", "Pop", "Tink", "Basso", "Blow", "Bottle",
        "Frog", "Funk", "Hero", "Morse", "Ping", "Purr", "Sosumi", "Submarine",
    ];

    // ── Derived Visibility ────────────────────────────────────────────────────

    public Visibility ErrorVisibility => _lastError is not null ? Visibility.Visible : Visibility.Collapsed;

    // ── Partial hooks ─────────────────────────────────────────────────────────

    partial void OnLastErrorChanged(string? value) => OnPropertyChanged(nameof(ErrorVisibility));

    // ─────────────────────────────────────────────────────────────────────────

    // DI uses this single-param constructor until N5-04 registers IVoiceWakeTesterService.
    public VoiceWakeSettingsViewModel(ISender sender)
        : this(sender, null) { }

    // Used by tests (substituted tester) and future DI full registration.
    public VoiceWakeSettingsViewModel(ISender sender, IVoiceWakeTesterService? tester)
    {
        _sender = sender;
        _tester = tester;
    }

    [RelayCommand]
    private async Task LoadAsync()
    {
        var result = await _sender.Send(new GetSettingsQuery());
        if (result.IsError) { LastError = result.FirstError.Description; return; }

        var s = result.Value;
        _current = s;

        VoiceWakeEnabled       = s.VoiceWakeEnabled;
        VoicePushToTalkEnabled = s.VoicePushToTalkEnabled;
        Sensitivity            = s.VoiceWakeSensitivity;

        TriggerWords.Clear();
        foreach (var w in s.VoiceWakeTriggerWords)
            TriggerWords.Add(w);

        await LoadMicsAsync(s.VoiceWakeMicId);
        await LoadLocalesAsync(s.VoiceWakeLocaleId);

        SelectedTriggerChimeIndex = Math.Max(0, AvailableChimes.IndexOf(s.VoiceWakeTriggerChime));
        SelectedSendChimeIndex    = Math.Max(0, AvailableChimes.IndexOf(s.VoiceWakeSendChime));

        LastError = null;
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        if (_current is null) return;

        _current.SetVoiceWakeEnabled(VoiceWakeEnabled);
        _current.SetVoicePushToTalkEnabled(VoicePushToTalkEnabled);
        _ = _current.SetVoiceWakeSensitivity((float)Sensitivity);
        _current.SetVoiceWakeTriggerWords([.. TriggerWords]);

        if (SelectedMicIndex >= 0 && SelectedMicIndex < AvailableMics.Count)
            _current.SetVoiceWakeMicId(AvailableMics[SelectedMicIndex].Id);

        if (SelectedLocaleIndex >= 0 && SelectedLocaleIndex < AvailableLocales.Count)
            _current.SetVoiceWakeLocaleId(AvailableLocales[SelectedLocaleIndex].Tag);

        if (SelectedTriggerChimeIndex >= 0 && SelectedTriggerChimeIndex < AvailableChimes.Count)
            _current.SetVoiceWakeTriggerChime(AvailableChimes[SelectedTriggerChimeIndex]);

        if (SelectedSendChimeIndex >= 0 && SelectedSendChimeIndex < AvailableChimes.Count)
            _current.SetVoiceWakeSendChime(AvailableChimes[SelectedSendChimeIndex]);

        var result = await _sender.Send(new SaveSettingsCommand(_current));
        if (result.IsError)
            LastError = result.FirstError.Description;
        else
            LastError = null;
    }

    [RelayCommand]
    private void AddTriggerWord()
    {
        var word = NewTriggerWord.Trim();
        if (!string.IsNullOrEmpty(word) && !TriggerWords.Contains(word, StringComparer.OrdinalIgnoreCase))
            TriggerWords.Add(word);
        NewTriggerWord = string.Empty;
    }

    [RelayCommand]
    private void RemoveTriggerWord(string word)
    {
        TriggerWords.Remove(word);
    }

    [RelayCommand]
    private async Task ToggleTestAsync()
    {
        if (_tester is null)
        {
            TestState = new VoiceWakeTestState.Failed("Voice wake tester not available.");
            return;
        }

        // Capture dispatcher so onUpdate callbacks can marshal back to UI thread.
        DispatcherQueue? queue = null;
        try { queue = DispatcherQueue.GetForCurrentThread(); }
        catch { /* headless / test context */ }

        void Dispatch(Action a)
        {
            if (queue is null) a();
            else queue.TryEnqueue(a.Invoke);
        }

        if (IsTesting)
        {
            _tester.Finalize();
            IsTesting = false;
            TestState  = VoiceWakeTestState.Finalizing.Instance;
            _testTimeoutCts?.Cancel();
            var cleanupCts = new CancellationTokenSource();
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(FinalizeCleanupMs, cleanupCts.Token);
                    Dispatch(() =>
                    {
                        if (TestState is VoiceWakeTestState.Finalizing)
                        {
                            _tester.Stop();
                            TestState = new VoiceWakeTestState.Failed("Stopped");
                        }
                    });
                }
                catch (OperationCanceledException) { }
            });
            return;
        }

        var triggers = TriggerWords.ToList();
        _tester.Stop();
        _testTimeoutCts?.Cancel();
        IsTesting = true;

        var micID    = SelectedMicIndex > 0 && SelectedMicIndex < AvailableMics.Count
                        ? AvailableMics[SelectedMicIndex].Id : null;
        var localeID = SelectedLocaleIndex >= 0 && SelectedLocaleIndex < AvailableLocales.Count
                        ? AvailableLocales[SelectedLocaleIndex].Tag : null;

        try
        {
            await _tester.StartAsync(
                triggers, micID, localeID,
                onUpdate: newState =>
                {
                    Dispatch(() =>
                    {
                        TestState = newState;
                        if (newState is VoiceWakeTestState.Detected or VoiceWakeTestState.Failed)
                        {
                            IsTesting = false;
                            _testTimeoutCts?.Cancel();
                        }
                    });
                });

            // Schedule 10 s hard timeout
            var cts = new CancellationTokenSource();
            _testTimeoutCts = cts;
            _ = Task.Run(async () =>
            {
                try
                {
                    await Task.Delay(TestTimeoutMs, cts.Token);
                    Dispatch(() =>
                    {
                        if (!cts.IsCancellationRequested && IsTesting)
                        {
                            _tester.Stop();
                            TestState = TestState is VoiceWakeTestState.Hearing h
                                ? new VoiceWakeTestState.Detected(h.Text)
                                : new VoiceWakeTestState.Failed("Timeout: no trigger heard");
                            IsTesting = false;
                        }
                    });
                }
                catch (OperationCanceledException) { }
            });
        }
        catch (Exception ex)
        {
            _tester.Stop();
            TestState = new VoiceWakeTestState.Failed(ex.Message);
            IsTesting = false;
            _testTimeoutCts?.Cancel();
        }
    }

    internal void StopTest()
    {
        _testTimeoutCts?.Cancel();
        _tester?.Stop();
        IsTesting = false;
        TestState  = VoiceWakeTestState.Idle.Instance;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private async Task LoadMicsAsync(string selectedId)
    {
        AvailableMics.Clear();
        AvailableMics.Add(new MicOption(string.Empty, "System Default"));

        try
        {
            var devices = await DeviceInformation.FindAllAsync(MediaDevice.GetAudioCaptureSelector());
            foreach (var d in devices)
                AvailableMics.Add(new MicOption(d.Id, d.Name));
        }
        catch
        {
            // Device enumeration fails when mic permission is not yet granted — default suffices.
        }

        var idx = AvailableMics.Select((m, i) => (m, i)).FirstOrDefault(t => t.m.Id == selectedId).i;
        SelectedMicIndex = idx;
    }

    private async Task LoadLocalesAsync(string selectedTag)
    {
        AvailableLocales.Clear();
        try
        {
            // SpeechRecognizer.SupportedTopicLanguages reflects speech pack installs on this machine.
            foreach (var lang in SpeechRecognizer.SupportedTopicLanguages.OrderBy(l => l.DisplayName))
                AvailableLocales.Add(new LocaleOption(lang.LanguageTag, lang.DisplayName));
        }
        catch
        {
            // Fallback: current culture only (speech recognition may not be available).
            var ci = CultureInfo.CurrentUICulture;
            AvailableLocales.Add(new LocaleOption(ci.Name, ci.DisplayName));
        }

        if (AvailableLocales.Count == 0)
            AvailableLocales.Add(new LocaleOption("en-US", "English (United States)"));

        var idx = AvailableLocales.Select((l, i) => (l, i)).FirstOrDefault(t => t.l.Tag == selectedTag).i;
        SelectedLocaleIndex = idx;
    }

    // ── Nested option types ───────────────────────────────────────────────────

    public sealed record MicOption(string Id, string Name);
    public sealed record LocaleOption(string Tag, string DisplayName);
}
