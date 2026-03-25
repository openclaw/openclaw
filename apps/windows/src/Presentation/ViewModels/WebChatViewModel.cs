using System.Collections.ObjectModel;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Media;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Chat;
using OpenClawWindows.Domain.Gateway;

namespace OpenClawWindows.Presentation.ViewModels;

/// <summary>
/// 1:1 mirror of OpenClawChatViewModel in OpenClawChatUI.
/// Push-based: subscribes to "chat" and "agent" gateway events via IChatPushSource.
/// No polling.
/// </summary>
internal sealed partial class WebChatViewModel : ObservableObject, IDisposable
{
    private readonly IGatewayRpcChannel  _rpc;
    private readonly IChatPushSource     _chatPush;
    private readonly ISettingsRepository _settings;
    private readonly ILogger<WebChatViewModel> _logger;

    private string?          _sessionKey;
    private DispatcherQueue? _queue;
    private Microsoft.UI.Xaml.Window? _hostWindow;

    private readonly HashSet<string> _pendingRuns = [];

    private const int PendingRunTimeoutMs = 120_000;
    private readonly Dictionary<string, CancellationTokenSource> _timeoutCts = [];

    // Last health poll timestamp
    private DateTime? _lastHealthPollAt;

    // Seam color from gateway settings
    // Null = use system accent. Triggers UserBubbleBrush recompute via NotifyPropertyChangedFor.
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UserBubbleBrush))]
    private string? _seamColorHex;

    // Responsive bubble width — updated by code-behind on MessageContainer SizeChanged.
    // 72% of the visible content area so bubbles reflow when the window is resized.
    [ObservableProperty]
    private double _bubbleMaxWidth = 420;

    /// <summary>User bubble background: seam color if available, else AccentFillColorDefaultBrush.</summary>
    public SolidColorBrush UserBubbleBrush
    {
        get
        {
            if (_seamColorHex is { Length: > 0 })
            {
                var c = TryParseHexColor(_seamColorHex);
                if (c.HasValue) return new SolidColorBrush(c.Value);
            }
            try
            {
                return (SolidColorBrush)Microsoft.UI.Xaml.Application.Current
                    .Resources["AccentFillColorDefaultBrush"];
            }
            catch { return new SolidColorBrush(global::Windows.UI.Color.FromArgb(255, 0, 103, 192)); }
        }
    }

    private static global::Windows.UI.Color? TryParseHexColor(string hex)
    {
        var h = hex.TrimStart('#');
        if (h.Length is not 6 and not 8) return null;
        try
        {
            byte a = h.Length == 8 ? System.Convert.ToByte(h[..2], 16) : (byte)255;
            int  o = h.Length == 8 ? 2 : 0;
            byte r = System.Convert.ToByte(h.Substring(o,     2), 16);
            byte g = System.Convert.ToByte(h.Substring(o + 2, 2), 16);
            byte b = System.Convert.ToByte(h.Substring(o + 4, 2), 16);
            return global::Windows.UI.Color.FromArgb(a, r, g, b);
        }
        catch { return null; }
    }

    // Persisted in ApplicationData.LocalSettings
    [ObservableProperty] private string _thinkingLevel = LoadPersistedThinkingLevel();

    partial void OnThinkingLevelChanged(string value)
    {
        // Persist on change
        try { global::Windows.Storage.ApplicationData.Current.LocalSettings.Values[ThinkingLevelKey] = value; }
        catch { /* AppData not available in test host — silently skip */ }
    }

    private const string ThinkingLevelKey = "openclaw.webchat.thinkingLevel";

    private static string LoadPersistedThinkingLevel()
    {
        try
        {
            var stored = global::Windows.Storage.ApplicationData.Current
                .LocalSettings.Values[ThinkingLevelKey] as string;
            return IsValidThinkingLevel(stored) ? stored! : "off";
        }
        catch { return "off"; }
    }

    private static bool IsValidThinkingLevel(string? v) =>
        v is "off" or "minimal" or "low" or "medium" or "high" or "xhigh" or "adaptive";

    [ObservableProperty] private bool    _isLoading;
    [ObservableProperty] private bool    _isAborting;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SendMessageCommand))]
    [NotifyPropertyChangedFor(nameof(IsSendEnabled))]
    private bool    _isSending;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SendMessageCommand))]
    [NotifyPropertyChangedFor(nameof(IsSendEnabled))]
    private string  _composeText = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ErrorBannerVisible))]
    [NotifyPropertyChangedFor(nameof(ErrorCardVisible))]
    private string? _lastError;

    // Banner (top strip) when error + has messages
    public bool ErrorBannerVisible => _lastError is not null && Messages.Count > 0;
    // Card (centered) when error + no messages
    public bool ErrorCardVisible   => _lastError is not null && Messages.Count == 0;

    [RelayCommand]
    private void DismissError() => LastError = null;
    [ObservableProperty] private string  _sessionLabel = "Chat";
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsEmptyState))]
    private string? _streamingAssistantText;

    // When false, SendMessage is blocked
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SendMessageCommand))]
    [NotifyPropertyChangedFor(nameof(IsSendEnabled))]
    [NotifyPropertyChangedFor(nameof(ConnectionStatusText))]
    private bool    _healthOK;

    /// <summary>"Connected" or "Connecting…"
    public string ConnectionStatusText => _healthOK ? "Connected" : "Connecting\u2026";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SendMessageCommand))]
    [NotifyPropertyChangedFor(nameof(IsSendEnabled))]
    [NotifyPropertyChangedFor(nameof(IsTyping))]
    [NotifyPropertyChangedFor(nameof(IsEmptyState))]
    private int     _pendingRunCount;

    public bool IsTyping => _pendingRunCount > 0;

    public bool IsEmptyState =>
        Messages.Count == 0 &&
        !Presentation.Helpers.AssistantTextParser.HasVisibleContent(StreamingAssistantText ?? string.Empty) &&
        PendingRunCount == 0 &&
        PendingToolCalls.Count == 0;

    public ObservableCollection<ChatMessageRow> Messages { get; } = [];
    public ObservableCollection<PendingAttachment> Attachments { get; } = [];
    public ObservableCollection<PendingToolCall> PendingToolCalls { get; } = [];

    // Backing dict for O(1) updates
    private readonly Dictionary<string, PendingToolCall> _pendingToolCallsById = [];

    public bool HasAttachments => Attachments.Count > 0;
    public bool HasPendingToolCalls => PendingToolCalls.Count > 0;

    // Model list — populated by FetchModelsAsync on bootstrap.
    public ObservableCollection<ModelChoice> AvailableModels { get; } = [];
    // Show picker only when the gateway returns multiple models
    public bool HasModelPicker => AvailableModels.Count > 1;

    // Currently-selected model for this session — null means gateway default.
    // OnSelectedModelChanged patches the session when changed by the user (not during sync).
    [ObservableProperty] private ModelChoice? _selectedModel;

    // Guards against sending sessions.patch during bootstrap sync.
    private bool _syncingModelId;

    partial void OnSelectedModelChanged(ModelChoice? value)
    {
        if (_syncingModelId || _sessionKey is null) return;
        var key = _sessionKey;
        var modelId = value?.Id;
        _ = Task.Run(async () =>
        {
            try { await _rpc.PatchSessionModelAsync(key, modelId, CancellationToken.None); }
            catch { /* best-effort */ }
        });
    }

    // Exposed for session picker sync in the view.
    public string? CurrentSessionKey => _sessionKey;

    // Session list
    private IReadOnlyList<Application.Ports.ChatSessionEntry> _sessions = [];

    // Computed session choices for the picker
    // main first, then sessions updated in the last 24h, then current if not already included.
    public IReadOnlyList<Application.Ports.ChatSessionEntry> SessionChoices
    {
        get
        {
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var cutoffMs = nowMs - (24L * 60 * 60 * 1000);
            var sorted = _sessions.OrderByDescending(s => s.UpdatedAt ?? 0).ToList();

            var result = new List<Application.Ports.ChatSessionEntry>();
            var included = new HashSet<string>(StringComparer.Ordinal);

            var main = sorted.FirstOrDefault(s => s.Key == "main")
                       ?? new Application.Ports.ChatSessionEntry { Key = "main" };
            result.Add(main);
            included.Add(main.Key);

            foreach (var s in sorted)
            {
                if (included.Contains(s.Key)) continue;
                if ((s.UpdatedAt ?? 0) < cutoffMs) continue;
                result.Add(s);
                included.Add(s.Key);
            }

            if (_sessionKey is not null && !included.Contains(_sessionKey))
            {
                var current = sorted.FirstOrDefault(s => s.Key == _sessionKey)
                              ?? new Application.Ports.ChatSessionEntry { Key = _sessionKey };
                result.Add(current);
            }

            return result;
        }
    }

    public bool HasMultipleSessions => SessionChoices.Count > 1;

    // Raised after Messages is updated so the view can scroll to bottom.
    public event Action? MessagesUpdated;

    // Thinking-stripped version of StreamingAssistantText — what the UI should actually show.
    // Null when there is no visible content (e.g. only <think> blocks in the stream).
    public string? StreamingVisibleText =>
        Presentation.Helpers.AssistantTextParser.HasVisibleContent(StreamingAssistantText ?? string.Empty)
            ? StreamingAssistantText
            : null;

    // Only scroll on first streaming chunk (null → text) — avoids scroll spam on every token.
    partial void OnStreamingAssistantTextChanged(string? oldValue, string? newValue)
    {
        OnPropertyChanged(nameof(StreamingVisibleText));
        if (oldValue is null && newValue is not null)
            MessagesUpdated?.Invoke();
    }

    public WebChatViewModel(
        IGatewayRpcChannel rpc,
        IChatPushSource chatPush,
        ISettingsRepository settings,
        ILogger<WebChatViewModel> logger)
    {
        _rpc      = rpc;
        _chatPush = chatPush;
        _settings = settings;
        _logger   = logger;
    }

    // Called by WebChatWindow after InitializeComponent, once DispatcherQueue is available.
    public void Initialize(string sessionKey, DispatcherQueue queue, Microsoft.UI.Xaml.Window? hostWindow = null)
    {
        _sessionKey  = sessionKey;
        _queue       = queue;
        _hostWindow  = hostWindow;
        SessionLabel = sessionKey is "global" or "main"
            ? "Chat"
            : $"Chat — {sessionKey}";

        _chatPush.ChatEventReceived  += OnChatEvent;
        _chatPush.AgentEventReceived += OnAgentEvent;
        _chatPush.HealthReceived     += OnHealthEvent;
        _chatPush.TickReceived       += OnTickEvent;
        _chatPush.SeqGapReceived     += OnSeqGapEvent;

        // Propagate collection changes to IsEmptyState and error visibility.
        Messages.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(IsEmptyState));
            OnPropertyChanged(nameof(ErrorBannerVisible));
            OnPropertyChanged(nameof(ErrorCardVisible));
        };
        PendingToolCalls.CollectionChanged += (_, _) => OnPropertyChanged(nameof(IsEmptyState));

        // bootstrap
        _ = BootstrapAsync();
    }

    public void Dispose()
    {
        _chatPush.ChatEventReceived  -= OnChatEvent;
        _chatPush.AgentEventReceived -= OnAgentEvent;
        _chatPush.HealthReceived     -= OnHealthEvent;
        _chatPush.TickReceived       -= OnTickEvent;
        _chatPush.SeqGapReceived     -= OnSeqGapEvent;

        foreach (var cts in _timeoutCts.Values) cts.Cancel();
        _timeoutCts.Clear();
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    [RelayCommand(CanExecute = nameof(CanSend))]
    private async Task SendMessageAsync()
    {
        if (_sessionKey is null) return;

        var trimmed = ComposeText.Trim();
        var messageText = string.IsNullOrEmpty(trimmed) && Attachments.Count > 0
            ? "See attached."
            : trimmed;
        if (string.IsNullOrEmpty(messageText)) return;

        // Guard
        if (!HealthOK)
        {
            LastError = "Gateway not connected; cannot send.";
            return;
        }

        IsSending = true;
        LastError = null;

        var idempotencyKey = Guid.NewGuid().ToString();
        _pendingRuns.Add(idempotencyKey);
        PendingRunCount = _pendingRuns.Count;
        ArmPendingRunTimeout(idempotencyKey);
        _pendingToolCallsById.Clear();
        SyncPendingToolCalls();
        StreamingAssistantText = null;

        // Optimistically append user message
        Messages.Add(new ChatMessageRow(
            Id:          Guid.NewGuid(),
            Role:        "user",
            Text:        messageText,
            IsUser:      true,
            IsAssistant: false,
            IsToolResult: false,
            ToolName:    null,
            Timestamp:   DateTimeOffset.UtcNow));
        MessagesUpdated?.Invoke();

        ComposeText = string.Empty;

        try
        {
            // Build attachment payloads from pending list, then clear.
            // type:"file" is the default attachment type.
            var attachmentPayloads = Attachments.Select(a => new ChatAttachment(
                Type:     "file",
                MimeType: a.MimeType,
                FileName: a.FileName,
                Content:  a.ContentBase64)).ToList();
            Attachments.Clear();
            OnPropertyChanged(nameof(HasAttachments));

            var result = await _rpc.ChatSendAsync(
                sessionKey:      _sessionKey,
                message:         messageText,
                thinking:        _thinkingLevel,
                idempotencyKey:  idempotencyKey,
                attachments:     attachmentPayloads,
                ct:              CancellationToken.None);

            // Gateway may return a different runId — update tracking + rearm timeout.
            if (result.ValueKind != JsonValueKind.Undefined)
            {
                var serverRunId = result.TryGetProperty("runId", out var r) ? r.GetString() : null;
                if (serverRunId is not null && serverRunId != idempotencyKey)
                {
                    DisarmPendingRunTimeout(idempotencyKey);
                    _pendingRuns.Remove(idempotencyKey);
                    _pendingRuns.Add(serverRunId);
                    PendingRunCount = _pendingRuns.Count;
                    ArmPendingRunTimeout(serverRunId);
                }
                _logger.LogInformation("chat.send ok runId={RunId} session={Session}", serverRunId, _sessionKey);
            }
        }
        catch (Exception ex)
        {
            _pendingRuns.Remove(idempotencyKey);
            PendingRunCount = _pendingRuns.Count;
            _logger.LogWarning(ex, "chat.send failed session={Session}", _sessionKey);
            LastError = ex.Message;
        }
        finally
        {
            IsSending = false;
        }
    }

    // Bindable property so XAML can drive IsEnabled/Style independently of Command.CanExecute.
    public bool IsSendEnabled => CanSend();
    // HealthOK is NOT a guard here; macOS only gates on health inside performSend.
    private bool CanSend() => !IsSending && PendingRunCount == 0 &&
        (!string.IsNullOrWhiteSpace(ComposeText) || Attachments.Count > 0);

    // ── Attachments

    [RelayCommand]
    private async Task PickFilesAsync()
    {
        try
        {
            var picker = new global::Windows.Storage.Pickers.FileOpenPicker();
            picker.FileTypeFilter.Add(".png");
            picker.FileTypeFilter.Add(".jpg");
            picker.FileTypeFilter.Add(".jpeg");
            picker.FileTypeFilter.Add(".gif");
            picker.FileTypeFilter.Add(".webp");
            picker.FileTypeFilter.Add(".bmp");
            picker.FileTypeFilter.Add(".pdf");
            picker.FileTypeFilter.Add(".txt");
            picker.FileTypeFilter.Add(".md");
            picker.FileTypeFilter.Add(".csv");
            picker.FileTypeFilter.Add(".json");
            picker.FileTypeFilter.Add(".xml");
            picker.FileTypeFilter.Add(".log");

            // WinUI3 requires initializing the picker with the window handle.
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(_hostWindow!);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);

            var files = await picker.PickMultipleFilesAsync();
            if (files is null) return;
            foreach (var file in files)
                await AddFileAsync(file);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PickFiles failed");
        }
    }

    internal async Task AddFileAsync(global::Windows.Storage.IStorageFile file)
    {
        var buffer = await global::Windows.Storage.FileIO.ReadBufferAsync(file);
        var data = new byte[buffer.Length];
        global::Windows.Security.Cryptography.CryptographicBuffer.CopyToByteArray(buffer, out data);
        var mime = file.ContentType ?? "application/octet-stream";
        Attachments.Add(new PendingAttachment(Guid.NewGuid(), file.Name, mime, data));
        OnPropertyChanged(nameof(HasAttachments));
    }

    internal void AddImageBytes(byte[] bytes, string fileName, string mimeType)
    {
        Attachments.Add(new PendingAttachment(Guid.NewGuid(), fileName, mimeType, bytes));
        OnPropertyChanged(nameof(HasAttachments));
    }

    internal async Task AddFilesFromPathsAsync(IEnumerable<string> paths)
    {
        foreach (var path in paths)
        {
            try
            {
                var file = await global::Windows.Storage.StorageFile.GetFileFromPathAsync(path);
                await AddFileAsync(file);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "AddFile failed: {Path}", path);
            }
        }
    }

    [RelayCommand]
    private void RemoveAttachment(Guid id)
    {
        var item = Attachments.FirstOrDefault(a => a.Id == id);
        if (item is not null)
        {
            Attachments.Remove(item);
            OnPropertyChanged(nameof(HasAttachments));
        }
    }

    [RelayCommand]
    private async Task AbortAsync()
    {
        // Guard against double-abort
        if (_isAborting || _pendingRuns.Count == 0 || _sessionKey is null) return;
        IsAborting = true;
        try
        {
            foreach (var runId in _pendingRuns.ToList())
            {
                try { await _rpc.ChatAbortAsync(_sessionKey, runId); }
                catch { /* best-effort */ }
            }
        }
        finally
        {
            IsAborting = false;
        }
    }

    [RelayCommand]
    private async Task RefreshAsync() => await BootstrapAsync();

    // ── Bootstrap

    private async Task BootstrapAsync()
    {
        if (_sessionKey is null) return;
        IsLoading = true;
        LastError = null;
        ClearPendingRuns();
        _pendingToolCallsById.Clear();
        SyncPendingToolCalls();
        StreamingAssistantText = null;

        // No-op for operator clients: chat.subscribe is a node-only RPC.
        // Best-effort — swallow any error, history/send/health still work without it.
        // Best-effort no-op: operator clients never need to subscribe.
        try { await _rpc.SetActiveSessionKeyAsync(_sessionKey, CancellationToken.None); }
        catch { /* best-effort */ }

        try
        {
            // Run network I/O off the UI thread to keep the window responsive.
            var result = await Task.Run(() =>
                _rpc.ChatHistoryAsync(_sessionKey, limit: 100, ct: CancellationToken.None));
            var rows = DecodeMessages(result);
            SyncThinkingLevelFromPayload(result);

            // Add messages in small batches yielding between each so the window
            // stays responsive during the initial render.
            Messages.Clear();
            const int batchSize = 5;
            for (int i = 0; i < rows.Count; i++)
            {
                Messages.Add(rows[i]);
                if ((i + 1) % batchSize == 0 && i + 1 < rows.Count)
                    await Task.Delay(1);
            }
            MessagesUpdated?.Invoke();

            _ = SyncSeamColorAsync();

            // Fire-and-forget the remaining RPCs so they don't block the UI.
            _ = Task.Run(() => PollHealthIfNeededAsync(force: true));

            await Task.Run(() => FetchSessionsAsync());

            await Task.Run(() => FetchModelsAsync());
            SyncSelectedModelFromSessions();
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            _logger.LogError(ex, "bootstrap failed session={Session}", _sessionKey);
        }
        finally
        {
            IsLoading = false;
            // Ensure Send button reflects current state after bootstrap completes.
            SendMessageCommand.NotifyCanExecuteChanged();
        }
    }

    // ── Session switcher

    private async Task FetchSessionsAsync()
    {
        try
        {
            _sessions = await _rpc.ListSessionsAsync(limit: 50, ct: CancellationToken.None);
            // SessionChoices is a computed prop — notify after backing field changes.
            if (_queue is not null)
                _queue.TryEnqueue(() =>
                {
                    OnPropertyChanged(nameof(SessionChoices));
                    OnPropertyChanged(nameof(HasMultipleSessions));
                });
            else
            {
                OnPropertyChanged(nameof(SessionChoices));
                OnPropertyChanged(nameof(HasMultipleSessions));
            }
        }
        catch { /* best-effort */ }
    }

    // Returns silently on failure so UI falls back to hidden picker (empty list).
    private async Task FetchModelsAsync()
    {
        var models = await _rpc.ListModelsAsync(ct: CancellationToken.None);
        void Apply()
        {
            AvailableModels.Clear();
            foreach (var m in models) AvailableModels.Add(m);
            OnPropertyChanged(nameof(HasModelPicker));
        }

        if (_queue is not null)
            _queue.TryEnqueue(Apply);
        else
            Apply();
    }

    // Sets SelectedModel from the current session entry — guards with _syncingModelId so
    // OnSelectedModelChanged does not fire sessions.patch during bootstrap.
    private void SyncSelectedModelFromSessions()
    {
        var current = _sessions.FirstOrDefault(s => s.Key == _sessionKey);
        if (current?.Model is null) return;
        var model = current.Model;

        void Apply()
        {
            _syncingModelId = true;
            SelectedModel = AvailableModels.FirstOrDefault(m => m.Id == model);
            _syncingModelId = false;
        }

        if (_queue is not null)
            _queue.TryEnqueue(Apply);
        else
            Apply();
    }

    [RelayCommand]
    private async Task SwitchSessionAsync(string sessionKey)
    {
        var next = sessionKey.Trim();
        if (string.IsNullOrEmpty(next) || next == _sessionKey) return;
        _sessionKey = next;
        SessionLabel = next is "global" or "main" ? "Chat" : $"Chat — {next}";
        await BootstrapAsync();
    }

    // ── Refresh after run

    private async Task RefreshHistoryAfterRunAsync()
    {
        if (_sessionKey is null) return;
        try
        {
            var result = await _rpc.ChatHistoryAsync(_sessionKey, limit: 100, ct: CancellationToken.None);
            var rawRows = DecodeMessages(result);
            SyncThinkingLevelFromPayload(result);

            // Incremental reconciliation: only append new messages to avoid full rerender.
            void Apply()
            {
                // Reuse existing Guids to minimize ItemsRepeater churn
                var rows = ReconcileMessageIds(Messages, rawRows);

                if (Messages.Count == 0)
                {
                    foreach (var row in rows) Messages.Add(row);
                }
                else
                {
                    // Match by comparing last N message texts — append only new ones.
                    var existingCount = Messages.Count;
                    var newCount = rows.Count;
                    if (newCount > existingCount)
                    {
                        for (int i = existingCount; i < newCount; i++)
                            Messages.Add(rows[i]);
                    }
                    else if (newCount != existingCount || !MessagesMatch(Messages, rows))
                    {
                        // Mismatch — full rebuild as fallback.
                        Messages.Clear();
                        foreach (var row in rows) Messages.Add(row);
                    }
                }
                MessagesUpdated?.Invoke();
            }

            if (_queue is not null)
                _queue.TryEnqueue(Apply);
            else
                Apply();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "refresh history failed session={Session}", _sessionKey);
        }
    }

    // ── Chat push handler

    private void OnChatEvent(JsonElement payload)
    {
        var sessionKey = GetStr(payload, "sessionKey");
        var state  = GetStr(payload, "state");
        var runId  = GetStr(payload, "runId");
        var errMsg = GetStr(payload, "errorMessage");

        var isOurRun = runId is not null && _pendingRuns.Contains(runId);

        // Session key mismatch — but never drop events for our own pending run.
        if (sessionKey is not null
            && !MatchesSessionKey(sessionKey, _sessionKey)
            && !isOurRun)
        {
            return;
        }

        void Update()
        {
            if (state is not ("final" or "error" or "aborted")) return;

            // Terminal state
            StreamingAssistantText = null;
            _pendingToolCallsById.Clear();
            SyncPendingToolCalls();

            // Re-evaluate on the UI thread: SendMessageAsync may have completed the
            // idempotencyKey→serverRunId swap in _pendingRuns after isOurRun was
            // captured on the gateway background thread.
            var isOurRunNow = runId is not null && _pendingRuns.Contains(runId);
            if (isOurRunNow)
            {
                if (state == "error")
                {
                    // Don't surface raw tool-result JSON in the error banner — the AI recovers on its own.
                    var msg = errMsg ?? "Chat failed";
                    LastError = IsToolResponseJson(msg) ? null : msg;
                }

                if (runId is not null)
                    ClearPendingRun(runId);
                else if (_pendingRuns.Count <= 1)
                    ClearPendingRuns();
            }
            _ = RefreshHistoryAfterRunAsync();
        }

        if (_queue is not null)
            _queue.TryEnqueue(Update);
        else
            Update();
    }

    // ── Agent push handler

    private void OnAgentEvent(JsonElement payload)
    {
        var stream = GetStr(payload, "stream") ?? string.Empty;

        string? assistantText = null;
        if (stream == "assistant"
            && payload.TryGetProperty("data", out var data)
            && data.TryGetProperty("text", out var textProp))
        {
            assistantText = textProp.GetString();
        }

        // Extract tool event fields upfront (outside Update lambda) to avoid capturing payload.
        string? toolPhase = null, toolName = null, toolCallId = null;
        JsonElement? toolArgs = null;
        double? toolTs = null;
        if (stream == "tool" && payload.TryGetProperty("data", out var toolData))
        {
            toolPhase   = GetStr(toolData, "phase");
            toolName    = GetStr(toolData, "name");
            toolCallId  = GetStr(toolData, "toolCallId");
            toolArgs    = toolData.TryGetProperty("args", out var a) ? a : null;
            toolTs      = payload.TryGetProperty("ts", out var tsProp) && tsProp.ValueKind == JsonValueKind.Number
                ? tsProp.GetDouble()
                : null;
        }

        void Update()
        {
            switch (stream)
            {
                case "assistant":
                    // Filter tool-response JSON that the gateway may echo as assistant text.
                    if (!IsToolResponseJson(assistantText ?? string.Empty))
                        StreamingAssistantText = assistantText;
                    break;
                case "tool":
                    if (toolPhase is null || toolName is null || toolCallId is null) break;

                    if (toolPhase == "start")
                    {
                        var call = new Domain.Chat.PendingToolCall(
                            ToolCallId: toolCallId,
                            Name:       toolName,
                            Args:       toolArgs,
                            StartedAt:  toolTs,
                            IsError:    null);
                        _pendingToolCallsById[toolCallId] = call;
                        SyncPendingToolCalls();
                    }
                    else if (toolPhase == "result")
                    {
                        _pendingToolCallsById.Remove(toolCallId);
                        SyncPendingToolCalls();
                    }
                    break;
            }
        }

        if (_queue is not null)
            _queue.TryEnqueue(Update);
        else
            Update();
    }

    // ── Pending run tracking ──────

    private void ClearPendingRun(string runId)
    {
        _pendingRuns.Remove(runId);
        PendingRunCount = _pendingRuns.Count;
        DisarmPendingRunTimeout(runId);
    }

    private void ClearPendingRuns()
    {
        foreach (var id in _pendingRuns.ToList())
            DisarmPendingRunTimeout(id);
        _pendingRuns.Clear();
        PendingRunCount = 0;
        // Without this, IsSending stays true after session switch and blocks the compose area.
        IsSending = false;
    }

    // Sorted by startedAt ascending
    private void SyncPendingToolCalls()
    {
        PendingToolCalls.Clear();
        foreach (var call in _pendingToolCallsById.Values.OrderBy(c => c.StartedAt ?? 0))
            PendingToolCalls.Add(call);
        OnPropertyChanged(nameof(HasPendingToolCalls));
    }

    // ── Session key matching

    private static bool MatchesSessionKey(string? incoming, string? current)
    {
        if (incoming == current) return true;
        if (incoming is null || current is null) return false;

        var inc = incoming.Trim().ToLowerInvariant();
        var cur = current.Trim().ToLowerInvariant();
        if (inc == cur) return true;

        // Generalized alias: "agent:{agentId}:{sessionKey}" ↔ "{sessionKey}" for any agentId.
        static string? AgentInner(string k)
        {
            var parts = k.Split(':');
            return parts.Length == 3 && parts[0] == "agent" ? parts[2] : null;
        }

        var incInner = AgentInner(inc);
        var curInner = AgentInner(cur);
        if (incInner is not null && incInner == cur) return true;
        if (curInner is not null && curInner == inc) return true;

        return false;
    }

    // Reads SeamColorHex from app settings best-effort
    private async Task SyncSeamColorAsync()
    {
        try
        {
            var s = await _settings.LoadAsync(CancellationToken.None);
            if (s.SeamColorHex is { Length: > 0 } hex)
            {
                if (_queue is not null)
                    _queue.TryEnqueue(() => SeamColorHex = hex);
                else
                    SeamColorHex = hex;
            }
        }
        catch { /* best-effort — no seam color is fine */ }
    }

    private static string? ReadSessionIdFromPayload(JsonElement root)
        => root.TryGetProperty("sessionId", out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()
            : null;

    // Updates ThinkingLevel from the chat.history payload's top-level thinkingLevel field.
    // Must be called on any thread — ThinkingLevel setter is thread-safe via ObservableProperty.
    private void SyncThinkingLevelFromPayload(JsonElement root)
    {
        if (!root.TryGetProperty("thinkingLevel", out var el) ||
            el.ValueKind != JsonValueKind.String) return;
        var level = el.GetString();
        if (!IsValidThinkingLevel(level)) return;
        if (_queue is not null)
            _queue.TryEnqueue(() => ThinkingLevel = level!);
        else
            ThinkingLevel = level!;
    }

    // ── Message decoding ───────────────────────────────────────────────────────

    private static List<ChatMessageRow> DecodeMessages(JsonElement root)
    {
        var rows = new List<ChatMessageRow>();

        if (!root.TryGetProperty("messages", out var msgs) ||
            msgs.ValueKind != JsonValueKind.Array)
            return rows;

        var seen = new HashSet<string>();

        foreach (var msg in msgs.EnumerateArray())
        {
            var role = GetStr(msg, "role") ?? "unknown";

            // Mirror macOS showsAssistantTrace=false: skip tool results entirely.
            if (role is "tool" or "tool_result" or "toolresult")
                continue;

            // Skip messages that contain tool_result content blocks — gateway sometimes
            // stores these as "user" messages with tool_result typed blocks.
            if (HasToolResultBlocks(msg)) continue;

            var rawText = ExtractText(msg);
            if (string.IsNullOrEmpty(rawText)) continue;

            // Skip messages whose sole text is a tool-response JSON envelope
            // (e.g. {"status":"error","tool":"canvas","error":"..."}).
            // These are tool call results that macOS filters via showsAssistantTrace=false.
            if (IsToolResponseJson(rawText)) continue;

            // Mirror macOS: preprocess all messages to extract inline images and strip
            // metadata (envelope headers, context blocks, etc. are no-ops on assistant text).
            var (text, images) = Presentation.Helpers.ChatMarkdownPreprocessor.PreprocessWithImages(rawText);

            if (string.IsNullOrEmpty(text)) continue;

            var ts = msg.TryGetProperty("timestamp", out var tsEl) && tsEl.ValueKind == JsonValueKind.Number
                ? DateTimeOffset.FromUnixTimeMilliseconds((long)tsEl.GetDouble())
                : (DateTimeOffset?)null;

            // Mirror macOS dedupeMessages: skip messages with the same role+timestamp+text.
            var key = DedupeKey(role, ts, text);
            if (key != null && !seen.Add(key)) continue;

            rows.Add(new ChatMessageRow(
                Id:           Guid.NewGuid(),
                Role:         role,
                Text:         text,
                IsUser:       role == "user",
                IsAssistant:  role == "assistant",
                IsToolResult: false,
                ToolName:     null,
                Timestamp:    ts,
                InlineImages: images.Count > 0 ? images : null));
        }

        return rows;
    }

    private static string? DedupeKey(string role, DateTimeOffset? timestamp, string text)
    {
        if (timestamp is null) return null;
        var trimmed = text.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return $"{role}|{timestamp.Value.ToUnixTimeMilliseconds()}|{trimmed}";
    }

    // Returns true if the message has any content block with type "tool_result" or "tool_use".
    private static bool HasToolResultBlocks(JsonElement msg)
    {
        if (!msg.TryGetProperty("content", out var content) ||
            content.ValueKind != JsonValueKind.Array) return false;
        foreach (var block in content.EnumerateArray())
        {
            var t = (GetStr(block, "type") ?? string.Empty).ToLowerInvariant();
            if (t is "tool_result" or "tool_use") return true;
        }
        return false;
    }

    // Returns true if the text is (or contains only) a tool call response envelope
    // ({"status":"error","tool":"...","error":"..."}).
    private static bool IsToolResponseJson(string text)
    {
        var t = text.Trim();
        if (t.Length < 10) return false;
        // Must look like a JSON object
        if (t[0] != '{') return false;
        return t.Contains("\"tool\"") && (t.Contains("\"status\"") || t.Contains("\"error\""));
    }

    // Extracts full text from tool_result messages (all content types).
    private static string ExtractToolResultText(JsonElement msg)
    {
        if (!msg.TryGetProperty("content", out var content)) return string.Empty;
        if (content.ValueKind == JsonValueKind.String)
            return content.GetString() ?? string.Empty;
        if (content.ValueKind == JsonValueKind.Array)
        {
            var parts = new System.Text.StringBuilder();
            foreach (var block in content.EnumerateArray())
            {
                var t = GetStr(block, "text");
                if (!string.IsNullOrEmpty(t)) parts.AppendLine(t);
            }
            return parts.ToString().TrimEnd();
        }
        return string.Empty;
    }

    // only extract type=="text" blocks, ignore thinking/tool_use/tool_result.
    private static string ExtractText(JsonElement msg)
    {
        if (msg.TryGetProperty("content", out var content))
        {
            if (content.ValueKind == JsonValueKind.String)
                return content.GetString() ?? string.Empty;

            if (content.ValueKind == JsonValueKind.Array)
            {
                var parts = new System.Text.StringBuilder();
                foreach (var block in content.EnumerateArray())
                {
                    var type = (GetStr(block, "type") ?? "text").ToLowerInvariant();
                    if (type is not "text" and not "") continue;
                    var t = GetStr(block, "text");
                    if (!string.IsNullOrEmpty(t)) parts.AppendLine(t);
                }
                return parts.ToString().TrimEnd();
            }
        }
        return string.Empty;
    }

    private static bool MessagesMatch(ObservableCollection<ChatMessageRow> existing, List<ChatMessageRow> incoming)
    {
        if (existing.Count != incoming.Count) return false;
        for (int i = 0; i < existing.Count; i++)
        {
            if (existing[i].Role != incoming[i].Role || existing[i].Text != incoming[i].Text)
                return false;
        }
        return true;
    }

    // Reuses Guids from the previous list when the message identity matches, so WinUI
    // ItemsRepeater can diff by key and avoid full re-render (no flicker).
    private static List<ChatMessageRow> ReconcileMessageIds(
        IList<ChatMessageRow> previous,
        List<ChatMessageRow> incoming)
    {
        if (previous.Count == 0 || incoming.Count == 0) return incoming;

        // Build a multi-map: identityKey → queue of GUIDs from previous list.
        var idsByKey = new Dictionary<string, Queue<Guid>>();
        foreach (var row in previous)
        {
            var key = MessageIdentityKey(row);
            if (key is null) continue;
            if (!idsByKey.TryGetValue(key, out var q))
                idsByKey[key] = q = new Queue<Guid>();
            q.Enqueue(row.Id);
        }

        var result = new List<ChatMessageRow>(incoming.Count);
        foreach (var row in incoming)
        {
            var key = MessageIdentityKey(row);
            if (key is not null
                && idsByKey.TryGetValue(key, out var q)
                && q.Count > 0)
            {
                var reusedId = q.Dequeue();
                if (q.Count == 0) idsByKey.Remove(key);
                result.Add(row with { Id = reusedId });
            }
            else
            {
                result.Add(row);
            }
        }
        return result;
    }

    // Key: role | timestamp-ms | text-length | text-prefix
    // Stable across refreshes for the same message — used by ReconcileMessageIds.
    private static string? MessageIdentityKey(ChatMessageRow row)
    {
        var role = row.Role.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(role)) return null;

        var ts = row.Timestamp.HasValue
            ? row.Timestamp.Value.ToUnixTimeMilliseconds().ToString()
            : string.Empty;

        var text = row.Text.Trim();

        if (string.IsNullOrEmpty(ts) && string.IsNullOrEmpty(text)) return null;

        // Use first 40 chars of text as fingerprint — enough to distinguish messages.
        var prefix = text.Length > 40 ? text[..40] : text;
        return $"{role}|{ts}|{text.Length}|{prefix}";
    }

    private static string? GetStr(JsonElement el, string key) =>
        el.TryGetProperty(key, out var p) && p.ValueKind == JsonValueKind.String
            ? p.GetString()
            : null;

    // ── Health event handler

    private void OnHealthEvent(bool ok)
    {
        void Update() { HealthOK = ok; }

        if (_queue is not null)
            _queue.TryEnqueue(Update);
        else
            Update();
    }

    // ── Tick event handler — triggers health poll ──

    private void OnTickEvent()
        => _ = PollHealthIfNeededAsync(force: false);

    // ── SeqGap event handler

    private void OnSeqGapEvent()
    {
        void Update()
        {
            LastError = null;
            ClearPendingRuns();
            StreamingAssistantText = null;
        }

        if (_queue is not null)
            _queue.TryEnqueue(Update);
        else
            Update();

        _ = Task.WhenAll(
            RefreshHistoryAfterRunAsync(),
            PollHealthIfNeededAsync(force: true));
    }

    // ── Health polling

    private async Task PollHealthIfNeededAsync(bool force)
    {
        if (!force && _lastHealthPollAt.HasValue &&
            (DateTime.UtcNow - _lastHealthPollAt.Value).TotalSeconds < 10)
            return;

        _lastHealthPollAt = DateTime.UtcNow;
        try
        {
            var ok = await _rpc.HealthOkAsync(timeoutMs: 5000);
            OnHealthEvent(ok);
        }
        catch
        {
            OnHealthEvent(false);
        }
    }

    // ── Pending run timeout

    private void ArmPendingRunTimeout(string runId)
    {
        if (_timeoutCts.TryGetValue(runId, out var existing))
        {
            existing.Cancel();
            _timeoutCts.Remove(runId);
        }

        var cts = new CancellationTokenSource();
        _timeoutCts[runId] = cts;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(PendingRunTimeoutMs, cts.Token);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            void Expire()
            {
                if (!_pendingRuns.Contains(runId)) return;
                ClearPendingRun(runId);
                LastError = "Timed out waiting for a reply; try again or refresh.";
            }

            if (_queue is not null)
                _queue.TryEnqueue(Expire);
            else
                Expire();
        }, CancellationToken.None);
    }

    private void DisarmPendingRunTimeout(string runId)
    {
        if (_timeoutCts.TryGetValue(runId, out var cts))
        {
            cts.Cancel();
            _timeoutCts.Remove(runId);
        }
    }
}
