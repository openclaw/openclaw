using Microsoft.Extensions.DependencyInjection;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Application.Stores;
using OpenClawWindows.Domain.Gateway;
using OpenClawWindows.Infrastructure.Audio;
using OpenClawWindows.Infrastructure.Automation;
using OpenClawWindows.Infrastructure.Autostart;
using OpenClawWindows.Infrastructure.Camera;
using OpenClawWindows.Infrastructure.DeepLinks;
using OpenClawWindows.Infrastructure.Updates;
using OpenClawWindows.Infrastructure.ExecApprovals;
using OpenClawWindows.Infrastructure.Gateway;
using OpenClawWindows.Infrastructure.Location;
using OpenClawWindows.Infrastructure.Logging;
using OpenClawWindows.Infrastructure.Notifications;
using OpenClawWindows.Infrastructure.Pairing;
using OpenClawWindows.Infrastructure.Permissions;
using OpenClawWindows.Infrastructure.Settings;
using OpenClawWindows.Infrastructure.Cron;
using OpenClawWindows.Infrastructure.Stores;
using OpenClawWindows.Infrastructure.NodeMode;
using OpenClawWindows.Infrastructure.Tailscale;
using OpenClawWindows.Infrastructure.TalkMode;
using OpenClawWindows.Infrastructure.Lifecycle;
using OpenClawWindows.Infrastructure.PortManagement;
using OpenClawWindows.Infrastructure.VoiceWake;

namespace OpenClawWindows.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services)
    {
        // ── Domain singletons (GAP-002a/b) ───────────────────────────────────
        services.AddSingleton(_ => GatewayConnection.Create("openclaw-control-ui"));
        services.AddSingleton(TimeProvider.System);

        // ── In-memory stores (GAP-007, GAP-053, GAP-054, GAP-055, GAP-060, GAP-065, GAP-066, GAP-067, GAP-056) ──
        services.AddSingleton<ITrayMenuStateStore, InMemoryTrayMenuStateStore>();
        services.AddSingleton<ISessionStore, InMemorySessionStore>();
        services.AddSingleton<IChannelStore, InMemoryChannelStore>();
        services.AddSingleton<IInstancesStore, InMemoryInstancesStore>();
        services.AddSingleton<IHealthStore, InMemoryHealthStore>();
        services.AddSingleton<IWorkActivityStore, InMemoryWorkActivityStore>();
        services.AddSingleton<IAgentEventStore, InMemoryAgentEventStore>();
        services.AddSingleton<ICronJobsStore, InMemoryCronJobsStore>();
        services.AddSingleton<IHeartbeatStore, InMemoryHeartbeatStore>();
        services.AddSingleton<INodesStore, InMemoryNodesStore>();
        services.AddSingleton<IGatewayEndpointStore, GatewayEndpointStore>();

        // ── Remote tunnel (GAP-023 / GAP-027) ────────────────────────────────
        // SshRemoteTunnelService spawns ssh -N -L forwarding when remote+ssh mode is active.
        services.AddSingleton<IRemoteTunnelService, SshRemoteTunnelService>();
        // RemoteTunnelManager wraps IRemoteTunnelService with restart backoff (2 s) and restartInFlight guard.
        services.AddSingleton<RemoteTunnelManager>();

        // ── Gateway ──────────────────────────────────────────────────────────
        // GatewayWebSocketAdapter implements IGatewayWebSocket + IHostedService.
        // Register as singleton and expose both interfaces from the same instance.
        services.AddSingleton<GatewayWebSocketAdapter>();
        services.AddSingleton<IGatewayWebSocket>(
            sp => sp.GetRequiredService<GatewayWebSocketAdapter>());
        services.AddHostedService(
            sp => sp.GetRequiredService<GatewayWebSocketAdapter>());

        // Receive loop — iterates ReceiveMessagesAsync() and dispatches frames to the RPC layer.
        // Separate from GatewayWebSocketAdapter to avoid a circular constructor dependency
        // between IGatewayWebSocket and IGatewayMessageRouter.
        services.AddHostedService<GatewayReceiveLoopHostedService>();

        // Reconnect coordinator — drives the initial connect and exponential-backoff reconnect.
        services.AddHostedService<GatewayReconnectCoordinatorHostedService>();

        // Connectivity coordinator — detects endpoint URL changes while connected and triggers refresh.
        // Also exposes ResolvedMode/HostLabel for UI.
        services.AddSingleton<GatewayConnectivityCoordinator>();
        services.AddHostedService(sp => sp.GetRequiredService<GatewayConnectivityCoordinator>());

        // GatewayRpcChannelAdapter implements IGatewayRpcChannel (public port) and
        // IGatewayMessageRouter (internal — called by the receive loop in GAP-017).
        // Same singleton instance is exposed under both interfaces.
        services.AddSingleton<GatewayRpcChannelAdapter>();
        services.AddSingleton<IGatewayRpcChannel>(
            sp => sp.GetRequiredService<GatewayRpcChannelAdapter>());
        services.AddSingleton<IGatewayMessageRouter>(
            sp => sp.GetRequiredService<GatewayRpcChannelAdapter>());
        services.AddSingleton<IPairingEventSource>(
            sp => sp.GetRequiredService<GatewayRpcChannelAdapter>());
        services.AddSingleton<IChatPushSource>(
            sp => sp.GetRequiredService<GatewayRpcChannelAdapter>());
        services.AddSingleton<IExecApprovalEventSource>(
            sp => sp.GetRequiredService<GatewayRpcChannelAdapter>());

        // Discovery sources — DiscoverGatewaysHandler consumes IEnumerable<IGatewayDiscovery>
        // and probes all sources concurrently. New sources can be added without modifying the handler.
        services.AddSingleton<IGatewayDiscovery, MdnsGatewayDiscoveryAdapter>();
        services.AddSingleton<IGatewayDiscovery, TailscaleServeGatewayDiscoveryAdapter>();
        // Wide-area DNS-SD discovery over Tailscale; activated by OPENCLAW_WIDE_AREA_DOMAIN env var.
        services.AddSingleton<IGatewayDiscovery, WideAreaGatewayDiscoveryAdapter>();

        // ── Camera ───────────────────────────────────────────────────────────
        // WinRTCameraAdapter satisfies both ICameraCapture and ICameraEnumerator.
        services.AddSingleton<WinRTCameraAdapter>();
        services.AddSingleton<ICameraCapture>(
            sp => sp.GetRequiredService<WinRTCameraAdapter>());
        services.AddSingleton<ICameraEnumerator>(
            sp => sp.GetRequiredService<WinRTCameraAdapter>());

        services.AddSingleton<IVideoMuxer, FFmpegVideoMuxerAdapter>();
        services.AddSingleton<IScreenCapture, WinRTScreenCaptureAdapter>();

        // ── Exec Approvals ───────────────────────────────────────────────────
        services.AddSingleton<IExecApprovalIpc, NamedPipeExecApprovalAdapter>();
        services.AddSingleton<IShellExecutor, ShellExecutorAdapter>();
        services.AddSingleton<IExecApprovalsRepository, JsonExecApprovalsRepository>();
        services.AddSingleton<ISkillBinsCache, SkillBinsCache>();

        // ── Notifications ────────────────────────────────────────────────────
        services.AddSingleton<INotificationProvider, WinRTNotificationAdapter>();

        // ── Location ─────────────────────────────────────────────────────────
        services.AddSingleton<IGeolocator, WinRTGeolocatorAdapter>();
        // Sends location.update events to the gateway when LocationMode is Always.
        services.AddHostedService<LocationUpdateMonitorHostedService>();

        // ── Audio / Speech ───────────────────────────────────────────────────
        services.AddSingleton<IAudioCaptureDevice, NAudioCaptureAdapter>();
        services.AddSingleton<MicLevelMonitor>();
        services.AddSingleton<ISpeechRecognizer, WinRTSpeechRecognizerAdapter>();
        services.AddSingleton<ISpeechSynthesizer, WinRTSpeechSynthAdapter>();

        // ── Talk mode runtime (GAP-049) ───────────────────────────────────────
        // WindowsTalkModeRuntime owns the full STT → silence → chatSend → TTS pipeline.
        // Named HttpClient for ElevenLabs: no fixed timeout (managed per-request via CancellationToken).
        services.AddHttpClient("elevenlabs-tts");
        services.AddSingleton<WindowsTalkModeRuntime>();
        services.AddSingleton<ITalkModeRuntime>(sp => sp.GetRequiredService<WindowsTalkModeRuntime>());
        services.AddHostedService(sp => sp.GetRequiredService<WindowsTalkModeRuntime>());

        // ── Voice Wake pipeline (N5-04) ──────────────────────────────────────
        services.AddSingleton<IPorcupineDetector, PorcupineWakeWordAdapter>();
        // VoiceWakeChimePlayer — plays trigger/send chimes.
        services.AddSingleton<IVoiceWakeChimePlayer, VoiceWakeChimePlayer>();
        // GlobalHotkeyVoicePushToTalk — WH_KEYBOARD_LL hotkey + speech pipeline for push-to-talk.
        services.AddSingleton<GlobalHotkeyVoicePushToTalk>();
        services.AddSingleton<IVoicePushToTalkService>(
            sp => sp.GetRequiredService<GlobalHotkeyVoicePushToTalk>());

        // ── Config store (gateway config read/write for Settings UI) ─────────
        services.AddSingleton<IConfigStore, OpenClawWindows.Infrastructure.Config.ConfigStore>();

        // ── Settings persistence ─────────────────────────────────────────────
        // JsonSettingsRepositoryAdapter needs IGatewayRpcChannel + GatewayConnection for NE-013
        // (gateway sync). Both are already singletons above, no cycle.
        services.AddSingleton<ISettingsRepository, JsonSettingsRepositoryAdapter>();
        services.AddHostedService<SettingsFileWatcher>();

        // ── Audit logging ────────────────────────────────────────────────────
        services.AddSingleton<IAuditLogger, SerilogAuditLoggerAdapter>();

        // ── Autostart ────────────────────────────────────────────────────────
        services.AddSingleton<ITaskScheduler, TaskSchedulerAdapter>();

        // ── Pairing / Keypair storage ─────────────────────────────────────────
        services.AddSingleton<IKeypairStorage, DpapiKeypairStorageAdapter>();

        // ── Pairing approval orchestrators (GAP-058) ─────────────────────────
        // Device and node pairing: queue gateway push events, show ContentDialog per request,
        // call approve/reject RPC. Node orchestrator also runs 15 s reconciliation loop and
        // silent SSH auto-approve.
        // Registered as singleton first so the tray menu can inject the pending-count interface
        // (needed for the pairing status lines added in N5-01).
        services.AddSingleton<DevicePairingApprovalOrchestrator>();
        services.AddSingleton<IDevicePairingPendingMonitor>(sp =>
            sp.GetRequiredService<DevicePairingApprovalOrchestrator>());
        services.AddHostedService(sp =>
            sp.GetRequiredService<DevicePairingApprovalOrchestrator>());

        services.AddSingleton<NodePairingApprovalOrchestrator>();
        services.AddSingleton<INodePairingPendingMonitor>(sp =>
            sp.GetRequiredService<NodePairingApprovalOrchestrator>());
        services.AddHostedService(sp =>
            sp.GetRequiredService<NodePairingApprovalOrchestrator>());

        // ── Exec approval gateway prompter (GAP-013) ─────────────────────────
        // Subscribes to "exec.approval.requested" push events, shows Allow Once / Allow Always / Deny
        // dialog, and calls exec.approval.resolve.
        services.AddHostedService<GatewayExecApprovalOrchestrator>();

        // ── Deep links ───────────────────────────────────────────────────────
        services.AddSingleton<IDeepLinkKeyStore, FileSystemDeepLinkKeyStore>();

        // ── Updater ──────────────────────────────────────────────────────────
        // Disabled for dev builds; MsixUpdaterController for production-signed packages.
        services.AddSingleton<IUpdaterController>(UpdaterControllerFactory.Create);

        // ── Permissions ──────────────────────────────────────────────────────
        // WindowsPermissionManager satisfies IPermissionManager.
        // Wire the singleton PermissionMonitor.Shared after resolution so it can poll.
        services.AddSingleton<IPermissionManager, WindowsPermissionManager>();
        services.AddSingleton(_ =>
        {
            var mgr = _.GetRequiredService<IPermissionManager>();
            PermissionMonitor.Shared.SetManager(mgr);
            return PermissionMonitor.Shared;
        });

        // ── Gateway process manager (GAP-018) ─────────────────────────────────
        // Singleton so status/log are accessible to UI ViewModels (DebugSettings, Tray).
        // IHostedService drives SetActive(true) on app launch.
        services.AddSingleton<WindowsGatewayProcessManager>();
        services.AddSingleton<IGatewayProcessManager>(
            sp => sp.GetRequiredService<WindowsGatewayProcessManager>());
        services.AddHostedService(
            sp => sp.GetRequiredService<WindowsGatewayProcessManager>());

        // ── Channels status polling (GAP-055) ────────────────────────────────
        // Polls channels.status every 45 s and stores the snapshot in IChannelStore.
        services.AddHostedService<ChannelsStatusPollingHostedService>();

        // ── Instances (presence) polling (GAP-060) ────────────────────────────
        // Polls system-presence every 30 s; also handles "presence" push events, snapshot, seqGap.
        services.AddHostedService<InstancesPollingHostedService>();

        // ── Nodes polling (N2-03) ────────────────────────────────────────────
        // Polls node.list every 30 s.
        services.AddHostedService<NodesPollingHostedService>();

        // ── Health polling (GAP-065) ──────────────────────────────────────────
        // Polls health every 60 s, decodes HealthSnapshot (with tolerant stray-log-line stripping).
        services.AddHostedService<HealthPollingHostedService>();

        // ── Cron jobs polling (GAP-056) ───────────────────────────────────────
        // Polls cron.status + cron.list every 30 s; also services event-triggered refreshes.
        services.AddHostedService<CronJobsPollingHostedService>();

        // ── Node mode (NE-GAP-C) — second WS with role:"node", TLS TOFU, independent backoff ──
        // Singleton so INodeEventSink (location.update, etc.) can reach the active session.
        // DISABLED: The node session reconnects every ~1.2s in a tight loop, saturating the
        services.AddSingleton<GatewayTlsPinStore>();
        services.AddSingleton<WindowsNodeModeCoordinator>();
        services.AddSingleton<INodeEventSink>(sp => sp.GetRequiredService<WindowsNodeModeCoordinator>());
        services.AddHostedService(sp => sp.GetRequiredService<WindowsNodeModeCoordinator>());

        // ── Node runtime context (N4-10) — session key + exec event emission ──
        // Must resolve after INodeEventSink; used by EvaluateExecRequestHandler for exec.* events.
        // Lazy<INodeEventSink> breaks the circular DI dependency:
        //   WindowsNodeModeCoordinator → INodeRuntimeContext → WindowsNodeRuntime → INodeEventSink → WindowsNodeModeCoordinator
        services.AddSingleton<Lazy<INodeEventSink>>(sp =>
            new Lazy<INodeEventSink>(() => sp.GetRequiredService<INodeEventSink>()));
        services.AddSingleton<WindowsNodeRuntime>();
        services.AddSingleton<INodeRuntimeContext>(sp => sp.GetRequiredService<WindowsNodeRuntime>());

        // ── Node runtime OS services (N4-09) — screen + location adapters for node commands ──
        services.AddSingleton<IWindowsNodeRuntimeServices, WindowsNodeRuntimeServices>();

        // ── Tailscale ─────────────────────────────────────────────────────────
        // Named HttpClient with 5s timeout — dedicated to the local Tailscale API (100.100.100.100)
        services.AddHttpClient("tailscale", c =>
        {
            c.Timeout = TimeSpan.FromSeconds(5);
        });
        services.AddSingleton<ITailscaleService, TailscaleService>();

        // ── Peekaboo bridge (N2-12) ───────────────────────────────────────────
        // Lifecycle stub: reads PeekabooBridgeEnabled at startup and enables the bridge if set.
        // The bridge server itself is macOS-only; this provides the settings-driven on/off lifecycle.
        services.AddHostedService<PeekabooBridgeHostCoordinator>();

        // ── Presence reporter (N2-11) ─────────────────────────────────────────
        // Pushes node identity, version, IP, and last-input on start ("launch") and every 180 s ("periodic").
        services.AddHostedService<PresenceReporter>();

        // ── Port guardian (N1-13 / N5-06) ────────────────────────────────────
        // Detects stray processes on the gateway port; swept at startup and on mode transitions.
        services.AddSingleton<PortGuardian>();
        services.AddSingleton<IPortGuardian>(sp => sp.GetRequiredService<PortGuardian>());

        // ── Termination signal watcher (N0-13) ───────────────────────────────
        // Installs SIGTERM + SIGINT handlers for graceful shutdown.
        services.AddHostedService<TerminationSignalWatcher>();

        // ── Browser proxy (GAP-035) ───────────────────────────────────────────
        // Timeout managed per-request (from params.timeoutMs) — no fixed timeout on client.
        services.AddHttpClient("browser-proxy");

        return services;
    }
}
