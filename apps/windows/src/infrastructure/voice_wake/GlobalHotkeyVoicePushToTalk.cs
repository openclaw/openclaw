using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.VoiceWake;
using OpenClawWindows.Domain.VoiceWake;

namespace OpenClawWindows.Infrastructure.VoiceWake;

/// <summary>
/// Global hotkey monitor and push-to-talk speech capture using WH_KEYBOARD_LL + ISpeechRecognizer.
/// </summary>
internal sealed class GlobalHotkeyVoicePushToTalk : IVoicePushToTalkService, IDisposable
{
    // Tunables
    internal const int GracePeriodMs = 1500; // 1_500_000_000 ns = 1.5 s — Swift: end() grace period

    // WinAPI
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN     = 0x0100;
    private const int WM_KEYUP       = 0x0101;
    private const int WM_SYSKEYDOWN  = 0x0104;
    private const int WM_SYSKEYUP    = 0x0105;
    // VK_RMENU = Right Alt; the push-to-talk trigger key.
    internal const int VK_RMENU = 0xA5;

    private readonly VoiceSessionCoordinator              _coordinator;
    private readonly ISpeechRecognizer                    _recognizer;
    private readonly IVoiceWakeChimePlayer                _chimePlayer;
    private readonly IVoiceWakeForwarder                  _forwarder;
    private readonly IPorcupineDetector                   _porcupine;
    private readonly ISettingsRepository                  _settings;
    private readonly DispatcherQueue                      _uiQueue;
    private readonly ILogger<GlobalHotkeyVoicePushToTalk> _logger;

    // Hotkey state — UI thread only
    private bool                    _altDown;
    private bool                    _active;
    private IntPtr                  _hookHandle = IntPtr.Zero;
    // Keep delegate alive to prevent GC while hook is installed.
    // Declared as field intentionally: a local delegate would be GC'd between hook install and callback.
#pragma warning disable S1450
    private LowLevelKeyboardProc?   _hookProc;
#pragma warning restore S1450

    // Session state — protected by _sem
    private readonly SemaphoreSlim           _sem = new(1, 1);
    private Guid?                            _sessionId;
    private string                           _committed     = "";
    private string                           _volatile_     = "";
    private string                           _adoptedPrefix = "";
    private Guid?                            _overlayToken;
    private bool                             _isCapturing;
    private bool                             _finalized;
    private Config?                          _activeConfig;
    private CancellationTokenSource?         _graceCts;
    private CancellationTokenSource?         _recogCts;

    private sealed record Config(
        string?        MicId,
        string?        LocaleId,
        VoiceWakeChime TriggerChime,
        VoiceWakeChime SendChime);

    public GlobalHotkeyVoicePushToTalk(
        VoiceSessionCoordinator               coordinator,
        ISpeechRecognizer                     recognizer,
        IVoiceWakeChimePlayer                 chimePlayer,
        IVoiceWakeForwarder                   forwarder,
        IPorcupineDetector                    porcupine,
        ISettingsRepository                   settings,
        DispatcherQueue                       uiQueue,
        ILogger<GlobalHotkeyVoicePushToTalk>  logger)
    {
        _coordinator = coordinator;
        _recognizer  = recognizer;
        _chimePlayer = chimePlayer;
        _forwarder   = forwarder;
        _porcupine   = porcupine;
        _settings    = settings;
        _uiQueue     = uiQueue;
        _logger      = logger;
    }

    // Dispatches to UI thread.
    internal void SetEnabled(bool enabled)
    {
        _uiQueue.TryEnqueue(() =>
        {
            if (enabled) StartMonitoring();
            else StopMonitoring();
        });
    }

    void IVoicePushToTalkService.SetEnabled(bool enabled) => SetEnabled(enabled);

    private void StartMonitoring()
    {
        if (_hookHandle != IntPtr.Zero) return;
        _hookProc   = HookCallback;
        _hookHandle = SetWindowsHookEx(WH_KEYBOARD_LL, _hookProc, GetModuleHandle(null), 0);
        if (_hookHandle == IntPtr.Zero)
            _logger.LogWarning(
                "Failed to install keyboard hook (error {E})", Marshal.GetLastWin32Error());
    }

    private void StopMonitoring()
    {
        if (_hookHandle == IntPtr.Zero) return;
        UnhookWindowsHookEx(_hookHandle);
        _hookHandle = IntPtr.Zero;
        _hookProc   = null;
        _altDown    = false;
        _active     = false;
    }

    // Fires on the UI message loop thread — kept minimal to avoid delaying system key events.
    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var kb     = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var msgId  = (int)wParam;
            var isDown = msgId == WM_KEYDOWN || msgId == WM_SYSKEYDOWN;
            var isUp   = msgId == WM_KEYUP   || msgId == WM_SYSKEYUP;
            if (kb.VkCode == VK_RMENU && (isDown || isUp))
                UpdateKeyState(isDown);
        }
        return CallNextHookEx(_hookHandle, nCode, wParam, lParam);
    }

    // Deduplicates hold — fires begin only on first key-down, end only on first key-up.
    private void UpdateKeyState(bool keyDown)
    {
        _altDown = keyDown;
        if (_altDown && !_active)
        {
            _active = true;
            _logger.LogInformation("ptt hotkey down");
            _ = Task.Run(() => BeginAsync());
        }
        else if (!_altDown && _active)
        {
            _active = false;
            _logger.LogInformation("ptt hotkey up");
            _ = Task.Run(() => EndAsync());
        }
    }

    // Test seam
    internal void _testUpdateKeyState(bool keyDown) => UpdateKeyState(keyDown);

    // ── Session lifecycle ─────────────────────────────────────────────────────

    internal async Task BeginAsync()
    {
        Guid sessionId;
        await _sem.WaitAsync();
        if (_isCapturing) { _sem.Release(); return; }
        _isCapturing = true;
        _finalized   = false;
        _graceCts?.Cancel(); _graceCts = null;
        sessionId  = Guid.NewGuid();
        _sessionId = sessionId;
        _sem.Release();

        var appSettings = await _settings.LoadAsync(CancellationToken.None);
        var config      = MakeConfig(appSettings);

        var (_, snapText, snapVisible) = _coordinator.Snapshot();
        var adopted = snapVisible ? snapText.Trim() : "";

        await _sem.WaitAsync();
        _activeConfig  = config;
        _adoptedPrefix = adopted;
        _sem.Release();

        _logger.LogInformation("ptt begin adopted_prefix_len={Len}", adopted.Length);

        if (config.TriggerChime is not VoiceWakeChime.None)
            _chimePlayer.Play(config.TriggerChime, "ptt.trigger");

        if (_porcupine.IsRunning)
            await _porcupine.StopAsync(CancellationToken.None);

        // Guard: end() may have arrived while we awaited settings/porcupine above.
        // If the session was already finalized, abort without starting recognition.
        await _sem.WaitAsync();
        var sessionStillActive = !_finalized && _sessionId == sessionId;
        _sem.Release();
        if (!sessionStillActive) return;

        var overlayToken = _coordinator.StartSession(
            VoiceSessionSource.PushToTalk, adopted, forwardEnabled: true);

        await _sem.WaitAsync();
        if (!_finalized && _sessionId == sessionId)
            _overlayToken = overlayToken;
        else
            _coordinator.Dismiss(overlayToken, VoiceDismissReason.Empty, VoiceSendOutcome.Empty);
        _sem.Release();

        try
        {
            await StartRecognitionAsync(config.LocaleId, sessionId);
        }
        catch (OperationCanceledException) { /* normal cancellation via _recogCts */ }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ptt recognition start failed");
            _coordinator.Dismiss(overlayToken, VoiceDismissReason.Empty, VoiceSendOutcome.Empty);
            await _sem.WaitAsync();
            _isCapturing = false;
            _sem.Release();
            if (_porcupine.IsAvailable)
                _ = _porcupine.StartAsync(CancellationToken.None);
        }
    }

    internal async Task EndAsync()
    {
        Guid? sessionId;
        await _sem.WaitAsync();
        if (!_isCapturing) { _sem.Release(); return; }
        _isCapturing = false;
        sessionId    = _sessionId;
        _recogCts?.Cancel();
        var hasContent = !string.IsNullOrEmpty(_committed)
                      || !string.IsNullOrEmpty(_volatile_)
                      || !string.IsNullOrEmpty(_adoptedPrefix);
        _sem.Release();

        if (!hasContent)
        {
            await FinalizeAsync("", "emptyOnRelease", sessionId);
            return;
        }

        _graceCts?.Cancel();
        var cts = new CancellationTokenSource();
        await _sem.WaitAsync();
        _graceCts = cts;
        _sem.Release();

        _ = Task.Run(async () =>
        {
            try { await Task.Delay(GracePeriodMs, cts.Token); }
            catch (OperationCanceledException) { return; }
            await FinalizeAsync(null, "timeout", sessionId);
        });
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async Task StartRecognitionAsync(string? localeId, Guid sessionId)
    {
        _ = localeId; // ISpeechRecognizer does not expose per-session locale selection on Windows

        var recogCts = new CancellationTokenSource();
        await _sem.WaitAsync();
        _recogCts?.Cancel();
        _recogCts = recogCts;
        _sem.Release();

        await _recognizer.StartContinuousAsync(
            RecognitionMode.Auto,
            onPartialResult: async (text, _) =>
                await HandleTranscriptAsync(text, isFinal: false, sessionId),
            onFinalResult: async (text, _) =>
                await HandleTranscriptAsync(text, isFinal: true, sessionId),
            ct: recogCts.Token);
    }

    private async Task HandleTranscriptAsync(string? transcript, bool isFinal, Guid sessionId)
    {
        Guid? token;
        string snapshot;
        await _sem.WaitAsync();
        try
        {
            if (_sessionId != sessionId)
            {
                _logger.LogDebug("push-to-talk drop transcript for stale session");
                return;
            }
            if (transcript is null) return;

            if (isFinal)
            {
                _committed = transcript;
                _volatile_ = "";
            }
            else
            {
                _volatile_ = Delta(_committed, transcript);
            }

            var committedWithPrefix = Join(_adoptedPrefix, _committed);
            snapshot = Join(committedWithPrefix, _volatile_);
            token    = _overlayToken;
        }
        finally { _sem.Release(); }

        if (token.HasValue)
            _coordinator.UpdatePartial(token.Value, snapshot);
    }

    private async Task FinalizeAsync(string? transcriptOverride, string reason, Guid? sessionId)
    {
        string  finalText;
        VoiceWakeChime chime;
        Guid?   token;

        await _sem.WaitAsync();
        if (_finalized) { _sem.Release(); return; }
        if (sessionId.HasValue && sessionId != _sessionId)
        {
            _logger.LogDebug("push-to-talk drop finalize for stale session");
            _sem.Release();
            return;
        }

        _finalized   = true;
        _isCapturing = false;
        _graceCts?.Cancel(); _graceCts = null;

        var finalRecognized = transcriptOverride is not null
            ? transcriptOverride.Trim()
            : (_committed + _volatile_).Trim();

        finalText = Join(_adoptedPrefix, finalRecognized);
        chime     = string.IsNullOrEmpty(finalText)
            ? new VoiceWakeChime.None()
            : (_activeConfig?.SendChime ?? new VoiceWakeChime.None());
        token = _overlayToken;

        // Cleanup under lock
        _recogCts?.Cancel();
        _recogCts      = null;
        _committed     = "";
        _volatile_     = "";
        _activeConfig  = null;
        _overlayToken  = null;
        _adoptedPrefix = "";
        _sem.Release();

        _logger.LogInformation(
            "ptt finalize reason={Reason} len={Len}", reason, finalText.Length);

        if (token.HasValue)
        {
            _coordinator.Finalize(token.Value, finalText, chime, autoSendAfter: null);
            _coordinator.SendNow(token.Value, reason);
        }
        else if (!string.IsNullOrEmpty(finalText))
        {
            // Fallback path
            if (chime is not VoiceWakeChime.None)
                _chimePlayer.Play(chime, "ptt.fallback_send");
            _ = Task.Run(() => _forwarder.ForwardAsync(finalText));
        }

        if (_porcupine.IsAvailable)
            _ = _porcupine.StartAsync(CancellationToken.None);
    }

    internal static string Join(string prefix, string suffix)
    {
        if (string.IsNullOrEmpty(prefix)) return suffix;
        if (string.IsNullOrEmpty(suffix)) return prefix;
        return $"{prefix} {suffix}";
    }

    // Inlined to avoid Presentation → Infrastructure circular dependency.
    internal static string Delta(string committed, string current)
        => current.StartsWith(committed, StringComparison.Ordinal)
            ? current[committed.Length..]
            : current;

    private static Config MakeConfig(Domain.Settings.AppSettings s)
    {
        var micId = string.IsNullOrEmpty(s.VoiceWakeMicId) ? null : s.VoiceWakeMicId;
        return new Config(
            MicId:        micId,
            LocaleId:     s.VoiceWakeLocaleId,
            TriggerChime: ParseChime(s.VoiceWakeTriggerChime),
            SendChime:    ParseChime(s.VoiceWakeSendChime));
    }

    private static VoiceWakeChime ParseChime(string name)
        => string.IsNullOrEmpty(name) || name.Equals("none", StringComparison.OrdinalIgnoreCase)
            ? new VoiceWakeChime.None()
            : new VoiceWakeChime.SystemSound(name);

    public void Dispose()
    {
        StopMonitoring();
        _graceCts?.Cancel();
        _graceCts?.Dispose();
        _recogCts?.Cancel();
        _recogCts?.Dispose();
        _sem.Dispose();
    }

    // ── P/Invoke ──────────────────────────────────────────────────────────────

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(
        int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint    VkCode;
        public uint    ScanCode;
        public uint    Flags;
        public uint    Time;
        public UIntPtr DwExtraInfo;
    }
}
