using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.TalkMode;

namespace OpenClawWindows.Infrastructure.TalkMode;

/// <summary>
/// Full talk-mode lifecycle: STT → 0.7 s silence gate → chatSend RPC → chatHistory poll → TTS.
/// </summary>
internal sealed class WindowsTalkModeRuntime : ITalkModeRuntime, IHostedService
{
    // Tunables
    private static readonly TimeSpan SilenceWindow = TimeSpan.FromSeconds(0.7);
    private const int SilenceCheckMs = 200;
    private const int PollIntervalMs = 300;
    private const int WaitTimeoutSeconds = 45;
    private const string DefaultModelId = "eleven_v3";
    private const string DefaultOutputFormat = "pcm_44100";

    private readonly ISpeechRecognizer _recognizer;
    private readonly ISpeechSynthesizer _systemVoice;
    private readonly IGatewayRpcChannel _rpc;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<WindowsTalkModeRuntime> _logger;

    // ── Phase machine (lock-protected) ──────────────────────────────────────
    private readonly object _lock = new();
    private bool _isEnabled;
    private bool _isPaused;
    private int _lifecycleGen;
    private TalkModePhase _phase = TalkModePhase.Idle;
    private string _lastTranscript = "";
    private DateTime? _lastHeard;
    private double? _lastInterruptedAt;
    private string? _lastSpokenText;

    // ── Config (lock-protected) ──────────────────────────────────────────────
    private string? _apiKey;
    private string? _defaultVoiceId;
    private string? _currentVoiceId;
    private string? _defaultModelId;
    private string? _currentModelId;
    private string? _defaultOutputFormat;
    private bool _interruptOnSpeech = true;
    private Dictionary<string, string> _voiceAliases = new();
    private bool _voiceOverrideActive;
    private bool _modelOverrideActive;
    private string? _fallbackVoiceId;

    // ── Task management ──────────────────────────────────────────────────────
    private CancellationTokenSource? _runCts;      // top-level: cancelled when disabled
    private CancellationTokenSource? _recCts;      // per recognition session
    private Task? _recTask;
    private CancellationTokenSource? _ttsCts;      // cancelled to interrupt TTS

    public TalkModePhase Phase { get { lock (_lock) return _phase; } }
    public event EventHandler<TalkModePhase>? PhaseChanged;
    public event EventHandler<double>? LevelChanged;

    public WindowsTalkModeRuntime(
        ISpeechRecognizer recognizer,
        ISpeechSynthesizer systemVoice,
        IGatewayRpcChannel rpc,
        IHttpClientFactory httpFactory,
        ILogger<WindowsTalkModeRuntime> logger)
    {
        _recognizer = recognizer;
        _systemVoice = systemVoice;
        _rpc = rpc;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    // ── IHostedService ───────────────────────────────────────────────────────

    public Task StartAsync(CancellationToken ct) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken ct) => await SetEnabledAsync(false);

    // ── ITalkModeRuntime ─────────────────────────────────────────────────────

    public async Task SetEnabledAsync(bool enabled)
    {
        bool changed;
        lock (_lock) { changed = enabled != _isEnabled; if (changed) _isEnabled = enabled; }
        if (!changed) return;

        Interlocked.Increment(ref _lifecycleGen);
        _logger.LogInformation("TalkMode enabled={Enabled}", enabled);

        if (enabled) await StartInternalAsync();
        else await StopInternalAsync();
    }

    public async Task SetPausedAsync(bool paused)
    {
        bool changed;
        lock (_lock) { changed = paused != _isPaused; if (changed) _isPaused = paused; }
        if (!changed) return;

        LevelChanged?.Invoke(this, 0);

        bool isEnabled;
        lock (_lock) { isEnabled = _isEnabled; }
        if (!isEnabled) return;

        if (paused)
        {
            lock (_lock) { _lastTranscript = ""; _lastHeard = null; }
            await StopRecognitionAsync();
            return;
        }

        TalkModePhase phase;
        lock (_lock) { phase = _phase; }
        if (phase is TalkModePhase.Idle or TalkModePhase.Listening)
        {
            await StartRecognitionAsync();
            UpdatePhase(TalkModePhase.Listening);
            _ = Task.Run(() => SilenceLoopAsync(_runCts?.Token ?? CancellationToken.None));
        }
    }

    public async Task StopSpeakingAsync(TalkStopReason reason)
    {
        CancellationTokenSource? ttsCts;
        lock (_lock) { ttsCts = _ttsCts; }
        ttsCts?.Cancel();
        await _systemVoice.StopAsync(CancellationToken.None);

        TalkModePhase phase;
        lock (_lock) { phase = _phase; }
        if (phase != TalkModePhase.Speaking) return;

        if (reason == TalkStopReason.Manual) return;
        if (reason is TalkStopReason.Speech or TalkStopReason.UserTap)
        {
            await StartListeningAsync();
            return;
        }
        UpdatePhase(TalkModePhase.Processing);
    }

    // ── Internal lifecycle ───────────────────────────────────────────────────

    private async Task StartInternalAsync()
    {
        var gen = _lifecycleGen;

        bool isPaused;
        lock (_lock) { isPaused = _isPaused; }
        if (isPaused)
        {
            UpdatePhase(TalkModePhase.Idle);
            LevelChanged?.Invoke(this, 0);
            return;
        }

        await ReloadConfigAsync();
        if (!IsCurrent(gen)) return;

        _runCts?.Cancel();
        _runCts?.Dispose();
        _runCts = new CancellationTokenSource();
        var runCt = _runCts.Token;

        await StartRecognitionAsync();
        if (!IsCurrent(gen)) return;

        UpdatePhase(TalkModePhase.Listening);
        _ = Task.Run(() => SilenceLoopAsync(runCt));
    }

    private async Task StopInternalAsync()
    {
        _runCts?.Cancel();
        _runCts?.Dispose();
        _runCts = null;

        _ttsCts?.Cancel();
        lock (_lock) { _ttsCts = null; }

        await _systemVoice.StopAsync(CancellationToken.None);
        await StopRecognitionAsync();

        lock (_lock) { _lastTranscript = ""; _lastHeard = null; }
        UpdatePhase(TalkModePhase.Idle);
        LevelChanged?.Invoke(this, 0);
    }

    private Task StartRecognitionAsync()
    {
        // Cancel previous session so its Task.Delay(Infinite) unblocks.
        _recCts?.Cancel();
        _recCts?.Dispose();

        _recCts = _runCts != null
            ? CancellationTokenSource.CreateLinkedTokenSource(_runCts.Token)
            : new CancellationTokenSource();

        var ct = _recCts.Token;
        _recTask = Task.Run(() => RunRecognitionAsync(ct));
        return Task.CompletedTask;
    }

    private async Task StopRecognitionAsync()
    {
        _recCts?.Cancel();
        _recCts?.Dispose();
        _recCts = null;
        await _recognizer.StopAsync(CancellationToken.None);
    }

    private async Task RunRecognitionAsync(CancellationToken ct)
    {
        try
        {
            await _recognizer.StartContinuousAsync(
                mode:            RecognitionMode.Auto,
                onPartialResult: (partial, _) => { HandlePartialTranscript(partial.Trim()); return Task.CompletedTask; },
                onFinalResult:   (final,   _) => { HandleFinalTranscript(final.Trim());     return Task.CompletedTask; },
                ct:              ct);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex) { _logger.LogError(ex, "talk: recognition error"); }
    }

    // ── Transcript handling ──────────────────────────────────────────────────

    private void HandlePartialTranscript(string text)
    {
        TalkModePhase phase;
        bool isPaused;
        lock (_lock) { phase = _phase; isPaused = _isPaused; }
        if (isPaused) return;

        if (phase == TalkModePhase.Speaking)
        {
            // Mirror shouldInterrupt() + interruptOnSpeech gate.
            bool interrupt;
            lock (_lock) { interrupt = _interruptOnSpeech; }
            if (interrupt && ShouldInterrupt(text))
            {
                lock (_lock) { _lastTranscript = ""; _lastHeard = null; }
                _ = Task.Run(() => StopSpeakingAsync(TalkStopReason.Speech));
            }
            return;
        }

        if (phase != TalkModePhase.Listening || string.IsNullOrEmpty(text)) return;

        lock (_lock) { _lastTranscript = text; _lastHeard = DateTime.UtcNow; }
    }

    private void HandleFinalTranscript(string text)
    {
        TalkModePhase phase;
        lock (_lock) { phase = _phase; }
        if (phase != TalkModePhase.Listening || string.IsNullOrEmpty(text)) return;
        lock (_lock) { _lastTranscript = text; }
    }

    // ── Silence monitor ──────────────────────────────────────────────────────

    private async Task SilenceLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(SilenceCheckMs, ct); }
            catch (OperationCanceledException) { break; }
            await CheckSilenceAsync();
        }
    }

    private async Task CheckSilenceAsync()
    {
        string transcript;
        DateTime? lastHeard;
        bool isPaused;
        TalkModePhase phase;
        lock (_lock)
        {
            isPaused = _isPaused;
            phase = _phase;
            transcript = _lastTranscript;
            lastHeard = _lastHeard;
        }

        if (isPaused || phase != TalkModePhase.Listening) return;
        if (string.IsNullOrEmpty(transcript) || lastHeard == null) return;
        if ((DateTime.UtcNow - lastHeard.Value) < SilenceWindow) return;

        await FinalizeTranscriptAsync(transcript);
    }

    private async Task FinalizeTranscriptAsync(string text)
    {
        lock (_lock) { _lastTranscript = ""; _lastHeard = null; }
        UpdatePhase(TalkModePhase.Processing);
        await StopRecognitionAsync();
        await SendAndSpeakAsync(text);
    }

    // ── Gateway + TTS pipeline ───────────────────────────────────────────────

    private async Task SendAndSpeakAsync(string transcript)
    {
        var gen = _lifecycleGen;
        await ReloadConfigAsync();
        if (!IsCurrent(gen)) return;

        double? interruptedAt;
        lock (_lock) { interruptedAt = _lastInterruptedAt; _lastInterruptedAt = null; }

        var prompt = BuildPrompt(transcript, interruptedAt);

        string sessionKey;
        try { sessionKey = await _rpc.MainSessionKeyAsync(15000, CancellationToken.None); }
        catch (Exception ex)
        {
            _logger.LogError(ex, "talk: cannot get session key");
            await ResumeListeningIfNeededAsync();
            return;
        }

        var runId = Guid.NewGuid().ToString("N");
        var startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0;
        _logger.LogInformation("talk send runId={RunId} session={Session} chars={Chars}",
            runId, sessionKey, prompt.Length);

        try
        {
            await _rpc.ChatSendAsync(
                sessionKey, prompt, thinking: "low", idempotencyKey: runId,
                attachments: [], timeoutMs: 30000, ct: CancellationToken.None);

            if (!IsCurrent(gen)) return;

            var assistantText = await WaitForAssistantTextAsync(sessionKey, startedAt, WaitTimeoutSeconds);
            if (assistantText == null)
            {
                _logger.LogWarning("talk: assistant text missing after {Timeout}s timeout", WaitTimeoutSeconds);
                await ResumeListeningIfNeededAsync();
                return;
            }
            if (!IsCurrent(gen)) return;

            _logger.LogInformation("talk: assistant text len={Len}", assistantText.Length);
            await PlayAssistantAsync(assistantText, gen);
            if (!IsCurrent(gen)) return;
            await ResumeListeningIfNeededAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "talk: chat.send failed");
            await ResumeListeningIfNeededAsync();
        }
    }

    private async Task<string?> WaitForAssistantTextAsync(string sessionKey, double since, int timeoutSeconds)
    {
        var deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
        while (DateTime.UtcNow < deadline)
        {
            var text = await LatestAssistantTextAsync(sessionKey, since);
            if (text != null) return text;
            await Task.Delay(PollIntervalMs);
        }
        return null;
    }

    private async Task<string?> LatestAssistantTextAsync(string sessionKey, double since)
    {
        try
        {
            var json = await _rpc.ChatHistoryAsync(sessionKey, timeoutMs: 10000);
            if (!json.TryGetProperty("messages", out var msgs) || msgs.ValueKind != JsonValueKind.Array)
                return null;

            string? result = null;
            foreach (var msg in msgs.EnumerateArray())
            {
                if (!msg.TryGetProperty("role", out var roleEl) || roleEl.GetString() != "assistant") continue;
                if (!msg.TryGetProperty("timestamp", out var tsEl) || tsEl.ValueKind != JsonValueKind.Number) continue;

                // TalkHistoryTimestamp.isAfter: handles both epoch-seconds and epoch-ms.
                var ts = tsEl.GetDouble();
                bool after = ts > 10_000_000_000
                    ? ts >= (since * 1000) - 500
                    : ts >= since - 0.5;
                if (!after) continue;

                if (!msg.TryGetProperty("content", out var contentEl)) continue;
                var sb = new System.Text.StringBuilder();
                foreach (var c in contentEl.EnumerateArray())
                {
                    if (c.TryGetProperty("type", out var typeEl) && typeEl.GetString() == "text"
                        && c.TryGetProperty("text", out var textEl))
                        sb.Append(textEl.GetString());
                }
                var text = sb.ToString().Trim();
                if (!string.IsNullOrEmpty(text)) result = text;
            }
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "talk: history fetch failed");
            return null;
        }
    }

    // ── TTS playback ─────────────────────────────────────────────────────────

    private async Task PlayAssistantAsync(string text, int gen)
    {
        var parse = TalkDirectiveParser.Parse(text);
        var cleaned = parse.Stripped.Trim();
        if (string.IsNullOrEmpty(cleaned)) return;
        if (!IsCurrent(gen)) return;

        if (parse.UnknownKeys.Count > 0)
            _logger.LogWarning("talk directive ignored keys: {Keys}", string.Join(",", parse.UnknownKeys));

        ApplyDirective(parse.Directive);
        lock (_lock) { _lastSpokenText = cleaned; }

        // Start recognition for interrupt-on-speech detection while TTS plays.
        await StartRecognitionAsync();
        UpdatePhase(TalkModePhase.Speaking);

        var ttsCts = new CancellationTokenSource();
        lock (_lock) { _ttsCts = ttsCts; }

        string? apiKey;
        string? voiceId;
        string? modelId;
        string outputFormat;
        lock (_lock)
        {
            apiKey = _apiKey;
            voiceId = _currentVoiceId ?? _defaultVoiceId;
            modelId = _currentModelId ?? _defaultModelId ?? DefaultModelId;
            outputFormat = _defaultOutputFormat ?? DefaultOutputFormat;
        }

        bool ttsHandled = false;

        if (!string.IsNullOrWhiteSpace(apiKey) && !string.IsNullOrWhiteSpace(voiceId))
        {
            try
            {
                await PlayElevenLabsAsync(cleaned, apiKey!, voiceId!, modelId, outputFormat, gen, ttsCts.Token);
                ttsHandled = true;
            }
            catch (OperationCanceledException) { ttsHandled = true; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "talk: ElevenLabs TTS failed; falling back to system voice");
            }
        }
        else if (string.IsNullOrWhiteSpace(apiKey))
        {
            _logger.LogWarning("talk: ELEVENLABS_API_KEY missing; using system voice");
        }

        if (!ttsHandled && IsCurrent(gen))
        {
            try { await _systemVoice.SpeakAsync(cleaned, ttsCts.Token); }
            catch (OperationCanceledException) { }
            catch (Exception ex) { _logger.LogError(ex, "talk: system voice failed"); }
        }

        lock (_lock) { if (_ttsCts == ttsCts) _ttsCts = null; }

        TalkModePhase phase;
        lock (_lock) { phase = _phase; }
        if (phase == TalkModePhase.Speaking)
            UpdatePhase(TalkModePhase.Processing);
    }

    private async Task PlayElevenLabsAsync(
        string text, string apiKey, string voiceId,
        string? modelId, string outputFormat, int gen, CancellationToken ct)
    {
        // Resolve fallback voice ID from ElevenLabs if not set.
        if (string.IsNullOrEmpty(voiceId))
        {
            string? fallback;
            lock (_lock) { fallback = _fallbackVoiceId; }
            if (fallback == null)
            {
                var client0 = new ElevenLabsTtsClient(apiKey, _httpFactory.CreateClient("elevenlabs-tts"));
                fallback = await client0.GetFirstVoiceIdAsync(ct);
                lock (_lock) { _fallbackVoiceId = fallback; }
            }
            voiceId = fallback ?? string.Empty;
            if (string.IsNullOrEmpty(voiceId)) return;
        }

        _logger.LogInformation("talk TTS voiceId={Voice} chars={Chars}", voiceId, text.Length);

        var client = new ElevenLabsTtsClient(apiKey, _httpFactory.CreateClient("elevenlabs-tts"));
        int sampleRate = ElevenLabsTtsClient.PcmSampleRate(outputFormat);

        if (sampleRate > 0)
        {
            bool ok = await client.StreamAndPlayAsync(voiceId, text, modelId, outputFormat, ct);
            if (ok || ct.IsCancellationRequested) return;
            // PCM failed; retry with MP3
            _logger.LogWarning("talk: PCM playback failed; retrying MP3");
            await client.StreamAndPlayAsync(voiceId, text, modelId, "mp3_44100_128", ct);
        }
        else
        {
            await client.StreamAndPlayAsync(voiceId, text, modelId, outputFormat, ct);
        }
    }

    // ── Listening helpers ────────────────────────────────────────────────────

    private async Task StartListeningAsync()
    {
        UpdatePhase(TalkModePhase.Listening);
        lock (_lock) { _lastTranscript = ""; _lastHeard = null; }
        LevelChanged?.Invoke(this, 0);
    }

    private async Task ResumeListeningIfNeededAsync()
    {
        bool isPaused;
        lock (_lock) { isPaused = _isPaused; }
        if (isPaused)
        {
            lock (_lock) { _lastTranscript = ""; _lastHeard = null; }
            LevelChanged?.Invoke(this, 0);
            return;
        }
        await StartListeningAsync();
        await StartRecognitionAsync();
    }

    // ── Config ───────────────────────────────────────────────────────────────

    private async Task ReloadConfigAsync()
    {
        var cfg = await FetchTalkConfigAsync();
        lock (_lock)
        {
            _defaultVoiceId = cfg.VoiceId;
            _voiceAliases = cfg.VoiceAliases;
            if (!_voiceOverrideActive) _currentVoiceId = cfg.VoiceId;
            _defaultModelId = cfg.ModelId;
            if (!_modelOverrideActive) _currentModelId = cfg.ModelId;
            _defaultOutputFormat = cfg.OutputFormat;
            _interruptOnSpeech = cfg.InterruptOnSpeech;
            _apiKey = cfg.ApiKey;
        }
        var hasKey = !string.IsNullOrEmpty(cfg.ApiKey);
        _logger.LogInformation(
            "talk config voiceId={Voice} modelId={Model} apiKey={HasKey} interrupt={Interrupt}",
            cfg.VoiceId ?? "none", cfg.ModelId ?? "none", hasKey, cfg.InterruptOnSpeech);
    }

    private async Task<TalkRuntimeConfig> FetchTalkConfigAsync()
    {
        // Environment overrides
        var envVoice  = Environment.GetEnvironmentVariable("ELEVENLABS_VOICE_ID")?.Trim();
        var sagVoice  = Environment.GetEnvironmentVariable("SAG_VOICE_ID")?.Trim();
        var envApiKey = Environment.GetEnvironmentVariable("ELEVENLABS_API_KEY")?.Trim();

        try
        {
            var raw = await _rpc.RequestRawAsync(
                "talk.config",
                new Dictionary<string, object?> { ["includeSecrets"] = true },
                timeoutMs: 8000);

            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;

            JsonElement cfgEl = default;
            if (root.TryGetProperty("config", out var c)) cfgEl = c;

            JsonElement? talkEl = null;
            if (cfgEl.ValueKind != JsonValueKind.Undefined && cfgEl.TryGetProperty("talk", out var t))
                talkEl = t;

            var providerCfg = SelectProviderConfig(talkEl);

            var voiceId    = StrProp(providerCfg, "voiceId")?.Trim();
            var modelId    = StrProp(providerCfg, "modelId")?.Trim();
            var outputFmt  = StrProp(providerCfg, "outputFormat");
            var apiKey     = StrProp(providerCfg, "apiKey")?.Trim();
            var interrupt  = BoolProp(talkEl, "interruptOnSpeech") ?? true;

            var aliases = new Dictionary<string, string>();
            if (providerCfg.HasValue && providerCfg.Value.TryGetProperty("voiceAliases", out var al))
            {
                foreach (var p in al.EnumerateObject())
                {
                    var k = p.Name.Trim().ToLowerInvariant();
                    var v = p.Value.GetString()?.Trim() ?? "";
                    if (!string.IsNullOrEmpty(k) && !string.IsNullOrEmpty(v)) aliases[k] = v;
                }
            }

            var resolvedVoice = (!string.IsNullOrEmpty(voiceId) ? voiceId : null)
                ?? (string.IsNullOrEmpty(envVoice) ? null : envVoice)
                ?? (string.IsNullOrEmpty(sagVoice) ? null : sagVoice);

            var resolvedKey = (string.IsNullOrEmpty(envApiKey) ? null : envApiKey)
                ?? (string.IsNullOrEmpty(apiKey) ? null : apiKey);

            return new TalkRuntimeConfig(resolvedVoice, aliases,
                string.IsNullOrEmpty(modelId) ? DefaultModelId : modelId,
                outputFmt, interrupt, resolvedKey);
        }
        catch
        {
            // Fallback: env-only config.
            var v = string.IsNullOrEmpty(envVoice) ? (string.IsNullOrEmpty(sagVoice) ? null : sagVoice) : envVoice;
            var k = string.IsNullOrEmpty(envApiKey) ? null : envApiKey;
            return new TalkRuntimeConfig(v, new(), DefaultModelId, null, true, k);
        }
    }

    // Selects the provider config block from the gateway talk.config payload.
    private static JsonElement? SelectProviderConfig(JsonElement? talk)
    {
        if (talk == null || talk.Value.ValueKind == JsonValueKind.Undefined) return null;

        // Normalized payload: has "provider" or "providers" key.
        bool hasProvider = talk.Value.TryGetProperty("provider", out _);
        bool hasProviders = talk.Value.TryGetProperty("providers", out var providers);
        if (hasProvider || hasProviders)
        {
            var providerId = (StrProp(talk, "provider")?.Trim().ToLowerInvariant()) ?? "elevenlabs";
            if (hasProviders)
            {
                foreach (var p in providers.EnumerateObject())
                {
                    if (p.Name.Trim().ToLowerInvariant() == providerId)
                        return p.Value;
                }
            }
            return null;
        }

        // Legacy flat format — treat the talk object itself as provider config.
        return talk;
    }

    // ── Voice alias + directive application ──────────────────────────────────

    private void ApplyDirective(TalkDirective? d)
    {
        if (d == null) return;
        if (d.VoiceId != null)
        {
            var resolved = ResolveVoiceAlias(d.VoiceId);
            if (resolved != null && d.Once != true)
                lock (_lock) { _currentVoiceId = resolved; _voiceOverrideActive = true; }
        }
        if (d.ModelId != null && d.Once != true)
            lock (_lock) { _currentModelId = d.ModelId; _modelOverrideActive = true; }
    }

    private string? ResolveVoiceAlias(string? value)
    {
        var trimmed = (value ?? "").Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        var normalized = trimmed.ToLowerInvariant();
        Dictionary<string, string> aliases;
        lock (_lock) { aliases = _voiceAliases; }
        if (aliases.TryGetValue(normalized, out var mapped)) return mapped;
        if (aliases.Values.Any(v => string.Equals(v, trimmed, StringComparison.OrdinalIgnoreCase))) return trimmed;
        // Treat as raw voice ID if it looks like one.
        return IsLikelyVoiceId(trimmed) ? trimmed : null;
    }

    private static bool IsLikelyVoiceId(string v) =>
        v.Length >= 10 && v.All(c => char.IsLetterOrDigit(c) || c == '-' || c == '_');

    // ── Interrupt detection ──────────────────────────────────────────────────

    // Simplified shouldInterrupt — no RMS energy gate (macOS uses AVAudioEngine tap).
    // Matches macOS length check (≥ 3) and echo-guard; skips lastSpeechEnergyAt gate.
    private bool ShouldInterrupt(string transcript)
    {
        if (transcript.Length < 3) return false;
        string? spoken;
        lock (_lock) { spoken = _lastSpokenText; }
        return !IsLikelyEcho(transcript, spoken);
    }

    private static bool IsLikelyEcho(string transcript, string? spokenText)
    {
        if (string.IsNullOrEmpty(spokenText)) return false;
        var probe  = transcript.ToLowerInvariant();
        var spoken = spokenText.ToLowerInvariant();
        return probe.Length < 6 ? spoken.Contains(probe) : spoken.Contains(probe);
    }

    // ── Phase updates ────────────────────────────────────────────────────────

    private void UpdatePhase(TalkModePhase phase)
    {
        lock (_lock) { _phase = phase; }
        PhaseChanged?.Invoke(this, phase);
        // Gateway phase notification is handled by TalkModeController.OnPhaseChanged (application layer).
    }

    private bool IsCurrent(int gen) => gen == _lifecycleGen && _isEnabled;

    // ── Prompt builder ───────────────────────────────────────────────────────

    private static string BuildPrompt(string transcript, double? interruptedAtSeconds)
    {
        var lines = new List<string>
        {
            "Talk Mode active. Reply in a concise, spoken tone.",
            "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {\"voice\":\"<id>\",\"once\":true}.",
        };
        if (interruptedAtSeconds.HasValue)
            lines.Add($"Assistant speech interrupted at {interruptedAtSeconds.Value:F1}s.");
        lines.Add("");
        lines.Add(transcript);
        return string.Join("\n", lines);
    }

    // ── JsonElement helpers ──────────────────────────────────────────────────

    private static string? StrProp(JsonElement? el, string key)
    {
        if (el == null || el.Value.ValueKind == JsonValueKind.Undefined) return null;
        return el.Value.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString() : null;
    }

    private static bool? BoolProp(JsonElement? el, string key)
    {
        if (el == null || el.Value.ValueKind == JsonValueKind.Undefined) return null;
        if (!el.Value.TryGetProperty(key, out var v)) return null;
        return v.ValueKind == JsonValueKind.True ? true : v.ValueKind == JsonValueKind.False ? false : null;
    }

    // ── Config record ────────────────────────────────────────────────────────

    private sealed record TalkRuntimeConfig(
        string? VoiceId,
        Dictionary<string, string> VoiceAliases,
        string? ModelId,
        string? OutputFormat,
        bool InterruptOnSpeech,
        string? ApiKey);
}
