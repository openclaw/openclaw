using System.Collections.ObjectModel;
using Microsoft.UI.Dispatching;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Presentation.ViewModels;

/// <summary>
/// Drives the full multi-page onboarding flow.
/// </summary>
internal sealed partial class OnboardingFlowViewModel : ObservableObject
{
    // Tunables
    internal const int WelcomePageId    = 0;
    internal const int ConnectionPageId = 1;
    internal const int WizardPageId     = 2;
    internal const int ReadyPageId      = 3;

    private readonly IGatewayDiscovery   _discovery;
    private readonly ISettingsRepository _settings;
    private readonly DispatcherQueue     _dispatcher;

    private CancellationTokenSource? _discoveryCts;

    // Raised when finish() determines the window should close.
    internal event Action? RequestClose;

    // Raised when the flow needs to navigate the Frame to a page (pageId = WelcomePageId etc.).
    // WizardPageId is never emitted here — it triggers WizardRequested instead.
    internal event Action<int>? NavigationRequested;

    // Raised when the wizard ContentDialog should be shown (Local mode only).
    internal event Action? WizardRequested;

    // ── Gateway wizard VM — property so the dialog can bind to it ────────────

    public OnboardingViewModel WizardVm { get; }

    // ── Page order ────────────────────────────────────────────────────────────

    private int[] _pageOrder = [WelcomePageId, ConnectionPageId, ReadyPageId];

    [ObservableProperty]
    [NotifyPropertyChangedFor(
        nameof(ActivePage), nameof(CanGoBack), nameof(CanGoNext), nameof(NextButtonTitle))]
    private int _currentStep;

    public int ActivePage => _pageOrder.Length > 0
        ? _pageOrder[Math.Clamp(_currentStep, 0, _pageOrder.Length - 1)]
        : WelcomePageId;

    // ── Connection page state ─────────────────────────────────────────────────

    public ObservableCollection<DiscoveredGatewayItem> DiscoveredGateways { get; } = [];

    [ObservableProperty] private bool   _isDiscovering;
    [ObservableProperty] private string _manualUrl = string.Empty;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(AdvancedToggleLabel))]
    private bool _showAdvanced;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsProbeReady), nameof(IsProbeFailed))]
    private ProbeStatus _probeStatus = ProbeStatus.Idle;

    [ObservableProperty] private string? _probeMessage;

    public bool IsProbeReady  => _probeStatus == ProbeStatus.Ready;
    public bool IsProbeFailed => _probeStatus == ProbeStatus.Failed;

    public string AdvancedToggleLabel => _showAdvanced ? "Hide Advanced" : "Advanced…";

    [ObservableProperty] private bool _isLocalSelected;
    [ObservableProperty] private bool _isUnconfiguredSelected;

    // ── Navigation dots ───────────────────────────────────────────────────────

    public ObservableCollection<DotItem> PageDots { get; } = [];

    // ── Navigation ────────────────────────────────────────────────────────────

    public bool CanGoBack => _currentStep > 0;
    public bool CanGoNext => true;

    public string NextButtonTitle =>
        _currentStep == _pageOrder.Length - 1 ? "Finish" : "Next";

    // ── Ready page ────────────────────────────────────────────────────────────

    [ObservableProperty] private bool _autoStart = true;

    // ── Construction ──────────────────────────────────────────────────────────

    public OnboardingFlowViewModel(
        IGatewayDiscovery   discovery,
        ISettingsRepository settings,
        DispatcherQueue     dispatcher,
        OnboardingViewModel wizardVm)
    {
        _discovery  = discovery;
        _settings   = settings;
        _dispatcher = dispatcher;
        WizardVm    = wizardVm;

        SelectUnconfigured();
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    internal async Task InitializeAsync(CancellationToken ct = default)
    {
        var s = await _settings.LoadAsync(ct);
        AutoStart = s.AutoStart;
        if (s.ConnectionMode == ConnectionMode.Local)
        {
            SelectLocal();
        }
        else if (s.ConnectionMode == ConnectionMode.Remote)
        {
            ManualUrl = s.GatewayEndpointUri ?? string.Empty;
            RebuildPageOrder(ConnectionMode.Remote);
        }
        else
        {
            SelectUnconfigured();
        }
    }

    // ── Mode selection ────────────────────────────────────────────────────────

    internal void SelectLocal()
    {
        IsLocalSelected        = true;
        IsUnconfiguredSelected = false;
        ClearGatewaySelection();
        ShowAdvanced           = false;
        RebuildPageOrder(ConnectionMode.Local);
    }

    internal void SelectGateway(DiscoveredGatewayItem gateway)
    {
        if (!WizardVm.IsComplete) _ = WizardVm.CancelAsync();
        ClearGatewaySelection();
        gateway.IsSelected     = true;
        IsLocalSelected        = false;
        IsUnconfiguredSelected = false;
        ManualUrl              = gateway.Uri;
        RebuildPageOrder(ConnectionMode.Remote);
    }

    internal void SelectUnconfigured()
    {
        if (!WizardVm.IsComplete) _ = WizardVm.CancelAsync();
        IsLocalSelected        = false;
        IsUnconfiguredSelected = true;
        ClearGatewaySelection();
        ShowAdvanced           = false;
        RebuildPageOrder(ConnectionMode.Unconfigured);
    }

    private void ClearGatewaySelection()
    {
        foreach (var g in DiscoveredGateways) g.IsSelected = false;
    }

    // ── Navigation commands ───────────────────────────────────────────────────

    [RelayCommand]
    private void GoBack()
    {
        if (_currentStep <= 0) return;

        if (ActivePage == WizardPageId) _ = WizardVm.CancelAsync();

        CurrentStep--;

        if (ActivePage == ConnectionPageId)
            _ = OnPageEntered(ConnectionPageId);
        else
            StopDiscovery();

        EmitNavigation();
    }

    [RelayCommand(CanExecute = nameof(CanGoNext))]
    private async Task GoNext()
    {
        if (_currentStep < _pageOrder.Length - 1)
        {
            CurrentStep++;
            await OnPageEntered(ActivePage);
        }
        else
        {
            await Finish();
        }
    }

    [RelayCommand]
    private void ToggleAdvanced()
    {
        ShowAdvanced = !ShowAdvanced;
        if (ShowAdvanced && !IsLocalSelected)
        {
            IsUnconfiguredSelected = false;
            ClearGatewaySelection();
            RebuildPageOrder(ConnectionMode.Remote);
        }
    }

    [RelayCommand]
    private void CheckConnection()
    {
        var url = ManualUrl.Trim();
        if (string.IsNullOrEmpty(url))
        {
            ProbeStatus  = ProbeStatus.Failed;
            ProbeMessage = "Enter a gateway URL first (ws:// or wss://).";
            return;
        }
        if (!url.StartsWith("ws://", StringComparison.OrdinalIgnoreCase) &&
            !url.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
        {
            ProbeStatus  = ProbeStatus.Failed;
            ProbeMessage = "URL must start with ws:// or wss://";
            return;
        }
        if (!Uri.TryCreate(url, UriKind.Absolute, out _))
        {
            ProbeStatus  = ProbeStatus.Failed;
            ProbeMessage = "URL is not valid.";
            return;
        }
        ProbeStatus  = ProbeStatus.Ready;
        ProbeMessage = "URL format is valid. Connection will be established after setup.";
        IsUnconfiguredSelected = false;
        IsLocalSelected        = false;
        ClearGatewaySelection();
        RebuildPageOrder(ConnectionMode.Remote);
    }

    // ── Wizard dialog callbacks ───────────────────────────────────────────────

    // Called by OnboardingWindow after the ContentDialog closes with wizard complete.
    internal async Task OnWizardCompleted()
    {
        CurrentStep++;
        await OnPageEntered(ActivePage);
    }

    // Called by OnboardingWindow after the ContentDialog is cancelled.
    internal void OnWizardCancelled()
    {
        _ = WizardVm.CancelAsync();
        CurrentStep--;
        _ = OnPageEntered(ConnectionPageId);
        EmitNavigation();
    }

    // ── Discovery ─────────────────────────────────────────────────────────────

    private void StartDiscovery()
    {
        if (_discoveryCts is not null) return;
        DiscoveredGateways.Clear();
        IsDiscovering = true;
        _discoveryCts = new CancellationTokenSource();
        var ct = _discoveryCts.Token;
        _ = Task.Run(() => RunDiscoveryAsync(ct), CancellationToken.None);
    }

    private void StopDiscovery()
    {
        _discoveryCts?.Cancel();
        _discoveryCts?.Dispose();
        _discoveryCts = null;
        IsDiscovering = false;
    }

    private async Task RunDiscoveryAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var ep in _discovery.DiscoverAsync(ct))
            {
                var item = new DiscoveredGatewayItem(ep.DisplayName, ep.Uri.ToString());
                _dispatcher.TryEnqueue(() =>
                {
                    if (!DiscoveredGateways.Any(g => g.Uri == item.Uri))
                        DiscoveredGateways.Add(item);
                });
            }
        }
        catch (OperationCanceledException) { }
        finally
        {
            _dispatcher.TryEnqueue(() => IsDiscovering = false);
        }
    }

    // ── Page lifecycle ────────────────────────────────────────────────────────

    private async Task OnPageEntered(int pageId)
    {
        switch (pageId)
        {
            case ConnectionPageId:
                // 150ms pause before starting discovery — gives the Frame time to render.
                await Task.Delay(150);
                StartDiscovery();
                EmitNavigation();
                break;
            case WizardPageId:
                StopDiscovery();
                WizardRequested?.Invoke();
                break;
            default:
                StopDiscovery();
                EmitNavigation();
                break;
        }
    }

    internal void OnWindowAppeared()
    {
        if (ActivePage == ConnectionPageId)
            _ = OnPageEntered(ConnectionPageId);
        else
            EmitNavigation();
        RebuildDots();
    }

    internal void OnWindowClosed()
    {
        StopDiscovery();
        if (!WizardVm.IsComplete) _ = WizardVm.CancelAsync();
    }

    // ── Finish ────────────────────────────────────────────────────────────────

    private async Task Finish()
    {
        try
        {
            var s    = await _settings.LoadAsync(CancellationToken.None);
            var mode = DetermineMode();
            s.SetConnectionMode(mode);
            s.SetOnboardingSeen(true);
            s.SetAutoStart(AutoStart);

            if (mode == ConnectionMode.Remote)
            {
                var selected = DiscoveredGateways.FirstOrDefault(g => g.IsSelected);
                var url      = selected?.Uri ?? ManualUrl.Trim();
                if (!string.IsNullOrEmpty(url))
                    s.SetGatewayEndpointUri(url);
            }

            await _settings.SaveAsync(s, CancellationToken.None);
        }
        catch { /* best-effort */ }

        RequestClose?.Invoke();
    }

    private ConnectionMode DetermineMode()
    {
        if (IsLocalSelected) return ConnectionMode.Local;
        if (IsUnconfiguredSelected) return ConnectionMode.Unconfigured;
        return ConnectionMode.Remote;
    }

    // ── Page order rebuild ────────────────────────────────────────────────────

    private void RebuildPageOrder(ConnectionMode mode)
    {
        // Local includes wizard step; Remote/Unconfigured skip it.
        _pageOrder = mode == ConnectionMode.Local
            ? [WelcomePageId, ConnectionPageId, WizardPageId, ReadyPageId]
            : [WelcomePageId, ConnectionPageId, ReadyPageId];

        var oldPage  = ActivePage;
        var idx      = Array.IndexOf(_pageOrder, oldPage);
        _currentStep = idx >= 0 ? idx : Math.Min(_currentStep, _pageOrder.Length - 1);

        RebuildDots();
        OnPropertyChanged(nameof(ActivePage));
        OnPropertyChanged(nameof(NextButtonTitle));
        OnPropertyChanged(nameof(CanGoBack));
        OnPropertyChanged(nameof(CanGoNext));
    }

    private void RebuildDots()
    {
        PageDots.Clear();
        for (var i = 0; i < _pageOrder.Length; i++)
            PageDots.Add(new DotItem(i == _currentStep));
    }

    private void EmitNavigation()
    {
        // WizardPageId is handled via WizardRequested, not NavigationRequested.
        if (ActivePage != WizardPageId)
            NavigationRequested?.Invoke(ActivePage);
    }

    partial void OnCurrentStepChanged(int value) => RebuildDots();
}

// ── Supporting types ──────────────────────────────────────────────────────────

internal sealed partial class DiscoveredGatewayItem : ObservableObject
{
    public string DisplayName { get; }
    public string Uri         { get; }
    [ObservableProperty] private bool _isSelected;

    internal DiscoveredGatewayItem(string displayName, string uri)
    {
        DisplayName = displayName;
        Uri         = uri;
    }
}

internal enum ProbeStatus { Idle, Checking, Ready, Failed }

internal sealed partial class DotItem : ObservableObject
{
    [ObservableProperty] private bool _isActive;
    internal DotItem(bool isActive) => _isActive = isActive;
}
