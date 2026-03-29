using System.Diagnostics;
using System.Drawing;

namespace OpenClaw.WindowsTray;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private const int PollIntervalMs = 10000;
    private const string NotifyTitle = "OpenClaw Gateway";

    private readonly NotifyIcon _notifyIcon;
    private readonly System.Windows.Forms.Timer _pollTimer;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _detailsItem;
    private readonly ToolStripMenuItem _startItem;
    private readonly ToolStripMenuItem _stopItem;
    private readonly ToolStripMenuItem _restartItem;
    private readonly ToolStripMenuItem _openLogsItem;
    private readonly ToolStripMenuItem _openConfigItem;
    private readonly ToolStripMenuItem _copyDiagnosticsItem;
    private readonly ToolStripMenuItem _launchAtLoginItem;

    private GatewayStatusSnapshot? _snapshot;
    private bool _busy;
    private bool _disposed;
    private bool _hasSeenInitialStatus;

    public TrayApplicationContext(string[] args)
    {
        _statusItem = new ToolStripMenuItem("Status: starting...")
        {
            Enabled = false,
        };
        _detailsItem = new ToolStripMenuItem("Waiting for the first gateway poll...")
        {
            Enabled = false,
        };
        _startItem = new ToolStripMenuItem("Start gateway", null, async (_, _) => await RunLifecycleActionAsync("start"));
        _stopItem = new ToolStripMenuItem("Stop gateway", null, async (_, _) => await RunLifecycleActionAsync("stop"));
        _restartItem = new ToolStripMenuItem(
            "Restart gateway",
            null,
            async (_, _) => await RunLifecycleActionAsync("restart")
        );
        _openLogsItem = new ToolStripMenuItem("Open logs folder", null, (_, _) => OpenLogsFolder());
        _openConfigItem = new ToolStripMenuItem("Open config folder", null, (_, _) => OpenConfigFolder());
        _copyDiagnosticsItem = new ToolStripMenuItem(
            "Copy diagnostics summary",
            null,
            async (_, _) => await CopyDiagnosticsSummaryAsync()
        );
        _launchAtLoginItem = new ToolStripMenuItem("Launch companion at login")
        {
            CheckOnClick = true,
            Checked = AutostartRegistry.IsEnabled(),
        };
        _launchAtLoginItem.Click += (_, _) => ToggleLaunchAtLogin();

        var menu = new ContextMenuStrip();
        menu.Items.AddRange(
            new ToolStripItem[]
            {
                _statusItem,
                _detailsItem,
                new ToolStripSeparator(),
                _startItem,
                _stopItem,
                _restartItem,
                new ToolStripSeparator(),
                _openLogsItem,
                _openConfigItem,
                _copyDiagnosticsItem,
                _launchAtLoginItem,
                new ToolStripSeparator(),
                new ToolStripMenuItem("Windows quickstart", null, (_, _) => OpenExternal(GatewayCli.DocsUrl)),
                new ToolStripMenuItem(
                    "Windows troubleshooting",
                    null,
                    (_, _) => OpenExternal(GatewayCli.TroubleshootingUrl)
                ),
                new ToolStripSeparator(),
                new ToolStripMenuItem("Quit", null, (_, _) => ExitThread()),
            }
        );

        _notifyIcon = new NotifyIcon
        {
            ContextMenuStrip = menu,
            Icon = ResolveIcon(GatewayTrayState.Unknown),
            Text = "OpenClaw Windows Companion",
            Visible = true,
        };
        _notifyIcon.DoubleClick += async (_, _) => await CopyDiagnosticsSummaryAsync();

        _pollTimer = new System.Windows.Forms.Timer
        {
            Interval = PollIntervalMs,
            Enabled = true,
        };
        _pollTimer.Tick += async (_, _) => await RefreshStatusAsync(showTransitionNotification: false);

        UpdateUi(new GatewayStatusSnapshot(
            GatewayTrayState.Unknown,
            "Waiting for gateway status.",
            "Polling `openclaw gateway status --json`.",
            null,
            GatewayCli.ResolveConfigDirectory(null),
            null
        ));

        _ = RefreshStatusAsync(showTransitionNotification: false);
    }

    protected override void ExitThreadCore()
    {
        if (_disposed)
        {
            base.ExitThreadCore();
            return;
        }

        _disposed = true;
        _pollTimer.Stop();
        _pollTimer.Dispose();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _refreshGate.Dispose();
        base.ExitThreadCore();
    }

    private async Task RunLifecycleActionAsync(string action)
    {
        if (_busy || _disposed)
        {
            return;
        }

        SetBusy(true);
        try
        {
            var result = await GatewayCli.RunLifecycleAsync(action);
            ShowBalloon(
                result.Ok ? ToolTipIcon.Info : ToolTipIcon.Error,
                result.Ok ? result.Summary : $"Gateway {action} failed.",
                result.Details
            );
            await RefreshStatusAsync(showTransitionNotification: false);
        }
        catch (Exception ex)
        {
            ShowBalloon(ToolTipIcon.Error, $"Gateway {action} failed.", ex.Message);
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task RefreshStatusAsync(bool showTransitionNotification)
    {
        if (_disposed)
        {
            return;
        }

        if (!await _refreshGate.WaitAsync(0))
        {
            return;
        }

        try
        {
            GatewayStatusSnapshot snapshot;
            try
            {
                snapshot = await GatewayCli.GetStatusAsync();
            }
            catch (Exception ex)
            {
                snapshot = new GatewayStatusSnapshot(
                    GatewayTrayState.Degraded,
                    "OpenClaw CLI status probe failed.",
                    ex.Message,
                    null,
                    GatewayCli.ResolveConfigDirectory(null),
                    "Install or expose the `openclaw` CLI, then retry."
                );
            }

            var previousState = _snapshot?.State ?? GatewayTrayState.Unknown;
            UpdateUi(snapshot);

            if (_hasSeenInitialStatus && showTransitionNotification && snapshot.State != previousState)
            {
                ShowStateTransitionNotification(snapshot);
            }

            _hasSeenInitialStatus = true;
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private void UpdateUi(GatewayStatusSnapshot snapshot)
    {
        _snapshot = snapshot;
        _notifyIcon.Icon = ResolveIcon(snapshot.State);
        _notifyIcon.Text = ToNotifyText($"OpenClaw: {snapshot.Summary}");

        _statusItem.Text = $"Status: {FormatState(snapshot.State)}";
        _detailsItem.Text = snapshot.Details ?? snapshot.Summary;
        _detailsItem.ToolTipText = BuildDiagnosticsText(snapshot);

        _startItem.Enabled = !_busy && snapshot.State != GatewayTrayState.Running;
        _stopItem.Enabled = !_busy && snapshot.State != GatewayTrayState.Stopped;
        _restartItem.Enabled = !_busy;

        var logsPath = ResolveLogsTarget(snapshot);
        _openLogsItem.Enabled = !_busy && !string.IsNullOrWhiteSpace(logsPath) && Directory.Exists(logsPath);
        _openConfigItem.Enabled = !_busy && Directory.Exists(snapshot.ConfigDirectory ?? string.Empty);
        _copyDiagnosticsItem.Enabled = !_busy;
        _launchAtLoginItem.Enabled = !_busy;
    }

    private void SetBusy(bool busy)
    {
        _busy = busy;
        if (_snapshot is not null)
        {
            UpdateUi(_snapshot);
        }
    }

    private void ToggleLaunchAtLogin()
    {
        try
        {
            AutostartRegistry.SetEnabled(_launchAtLoginItem.Checked);
            ShowBalloon(
                ToolTipIcon.Info,
                _launchAtLoginItem.Checked ? "Launch-at-login enabled." : "Launch-at-login disabled.",
                null
            );
        }
        catch (Exception ex)
        {
            _launchAtLoginItem.Checked = AutostartRegistry.IsEnabled();
            ShowBalloon(ToolTipIcon.Error, "Could not update launch-at-login.", ex.Message);
        }
    }

    private void OpenLogsFolder()
    {
        var target = ResolveLogsTarget(_snapshot);
        if (string.IsNullOrWhiteSpace(target) || !Directory.Exists(target))
        {
            ShowBalloon(ToolTipIcon.Warning, "Logs folder is not available yet.", null);
            return;
        }

        OpenExternal(target);
    }

    private void OpenConfigFolder()
    {
        var target = _snapshot?.ConfigDirectory;
        if (string.IsNullOrWhiteSpace(target))
        {
            target = GatewayCli.ResolveConfigDirectory(_snapshot?.LogsDirectory);
        }

        if (string.IsNullOrWhiteSpace(target))
        {
            ShowBalloon(ToolTipIcon.Warning, "Config folder is not available yet.", null);
            return;
        }

        Directory.CreateDirectory(target);
        OpenExternal(target);
    }

    private async Task CopyDiagnosticsSummaryAsync()
    {
        if (_snapshot is null)
        {
            await RefreshStatusAsync(showTransitionNotification: false);
        }

        if (_snapshot is null)
        {
            ShowBalloon(ToolTipIcon.Warning, "No diagnostics are available yet.", null);
            return;
        }

        Clipboard.SetText(BuildDiagnosticsText(_snapshot));
        ShowBalloon(ToolTipIcon.Info, "Diagnostics copied to the clipboard.", null);
    }

    private void ShowStateTransitionNotification(GatewayStatusSnapshot snapshot)
    {
        switch (snapshot.State)
        {
            case GatewayTrayState.Running:
                ShowBalloon(ToolTipIcon.Info, "Gateway is running.", snapshot.Details);
                break;
            case GatewayTrayState.Stopped:
                ShowBalloon(ToolTipIcon.Warning, "Gateway stopped.", snapshot.Details);
                break;
            case GatewayTrayState.Degraded:
                ShowBalloon(
                    ToolTipIcon.Warning,
                    "Gateway needs attention.",
                    snapshot.RecommendedAction ?? snapshot.Details ?? snapshot.Summary
                );
                break;
        }
    }

    private void ShowBalloon(ToolTipIcon icon, string title, string? body)
    {
        _notifyIcon.BalloonTipIcon = icon;
        _notifyIcon.BalloonTipTitle = title;
        _notifyIcon.BalloonTipText = body ?? string.Empty;
        _notifyIcon.ShowBalloonTip(4000);
    }

    private static string BuildDiagnosticsText(GatewayStatusSnapshot snapshot)
    {
        var lines = new[]
        {
            $"Status: {FormatState(snapshot.State)}",
            $"Summary: {snapshot.Summary}",
            snapshot.Details is not null ? $"Details: {snapshot.Details}" : null,
            snapshot.LogsDirectory is not null ? $"Logs: {snapshot.LogsDirectory}" : null,
            snapshot.ConfigDirectory is not null ? $"Config: {snapshot.ConfigDirectory}" : null,
            snapshot.RecommendedAction is not null ? $"Recommended action: {snapshot.RecommendedAction}" : null,
            $"CLI command: {GatewayCli.DisplayCommand} gateway status --json",
            $"Docs: {GatewayCli.DocsUrl}",
            $"Troubleshooting: {GatewayCli.TroubleshootingUrl}",
        };

        return string.Join(Environment.NewLine, lines.Where(line => !string.IsNullOrWhiteSpace(line)));
    }

    private static string? ResolveLogsTarget(GatewayStatusSnapshot? snapshot)
    {
        if (snapshot is null)
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(snapshot.LogsDirectory))
        {
            return snapshot.LogsDirectory;
        }

        return snapshot.ConfigDirectory;
    }

    private static void OpenExternal(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = target,
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                $"Could not open:\n{target}\n\n{ex.Message}",
                "OpenClaw Windows Companion",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning
            );
        }
    }

    private static Icon ResolveIcon(GatewayTrayState state)
    {
        return state switch
        {
            GatewayTrayState.Running => SystemIcons.Information,
            GatewayTrayState.Stopped => SystemIcons.Application,
            GatewayTrayState.Degraded => SystemIcons.Warning,
            _ => SystemIcons.Question,
        };
    }

    private static string FormatState(GatewayTrayState state)
    {
        return state switch
        {
            GatewayTrayState.Running => "Running",
            GatewayTrayState.Stopped => "Stopped",
            GatewayTrayState.Degraded => "Degraded",
            _ => "Unknown",
        };
    }

    private static string ToNotifyText(string text)
    {
        var singleLine = text.Replace('\r', ' ').Replace('\n', ' ');
        return singleLine.Length <= 63 ? singleLine : $"{singleLine[..60]}...";
    }
}
