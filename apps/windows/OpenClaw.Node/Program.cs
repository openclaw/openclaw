using System;
using System.Threading;
using System.Threading.Tasks;
using OpenClaw.Node.Protocol;
using OpenClaw.Node.Services;
using OpenClaw.Node.Tray;
using System.Collections.Generic;
using System.IO;
using System.Diagnostics;
using System.Text.Json;

namespace OpenClaw.Node
{
    class Program
    {
        static async Task Main(string[] args)
        {
            var startedAtUtc = DateTimeOffset.UtcNow;
            Console.WriteLine("OpenClaw Node for Windows starting...");

            var configPath = GetOpenClawConfigPath();
            var forceTray = HasArg(args, "--tray");
            var disableTray = HasArg(args, "--no-tray");
            var trayEnabled = !disableTray && (forceTray || OperatingSystem.IsWindows());
            string url = ResolveGatewayUrl(args, out var configReadErrorUrl);
            string token = ResolveGatewayToken(args, out var configReadErrorToken);
            var configReadError = configReadErrorUrl ?? configReadErrorToken;
            var hasGatewayToken = !string.IsNullOrWhiteSpace(token);

            if (!hasGatewayToken && !trayEnabled)
            {
                Console.WriteLine("[FATAL] Missing gateway token. Set OPENCLAW_GATEWAY_TOKEN, pass --gateway-token <token>, or run with --tray and open config.");
                return;
            }

            try
            {
            var connectParams = new ConnectParams
            {
                MinProtocol = Constants.GatewayProtocolVersion,
                MaxProtocol = Constants.GatewayProtocolVersion,
                Role = "node",
                Client = new Dictionary<string, object>
                {
                    { "id", "node-host" },
                    { "displayName", Environment.MachineName },
                    { "platform", "windows" },
                    { "mode", "node" },
                    { "version", "dev" },
                    { "instanceId", Guid.NewGuid().ToString() },
                    { "deviceFamily", "Windows" }
                },
                Caps = new List<string> { "screenRecording", "notifications", "microphone" },
                Locale = "en-US",
                UserAgent = Environment.OSVersion.VersionString,
                Scopes = new List<string>(),
                Commands = new List<string> { "system.run", "system.which", "system.notify", "screen.capture", "screen.list", "screen.record", "camera.list", "camera.snap", "window.list", "window.focus", "window.rect", "input.type", "input.key", "input.click", "input.scroll", "input.click.relative", "ui.find", "ui.click", "ui.type" },
                Permissions = new Dictionary<string, object>()
            };

            using var cts = new CancellationTokenSource();
            var restartRequested = false;

            var core = new CoreMethodService(startedAtUtc);
            using var ipc = new IpcPipeServerService(version: "dev", authToken: token);
            using var connection = new GatewayConnection(url, token, connectParams);
            var executor = new NodeCommandExecutor(connection);
            using var discovery = new DiscoveryService(connectParams, url);
            var trayStatus = new TrayStatusBroadcaster();
            var reconnectStartedAtUtc = (DateTimeOffset?)null;
            long? lastReconnectMs = null;
            var authDialogShown = false;
            var onboarding = OnboardingAdvisor.Evaluate(url, token, configPath, configReadError);

            void SetTray(NodeRuntimeState state, string message)
            {
                trayStatus.Set(state, message, core.PendingPairCount, lastReconnectMs, onboarding.StatusText);
            }

            ITrayHost? trayHost = null;

            if (trayEnabled)
            {
                trayHost = OperatingSystem.IsWindows()
                    ? new WindowsNotifyIconTrayHost(
                        log: msg => Console.WriteLine(msg),
                        onOpenLogs: () => OpenLogsFolder(),
                        onOpenConfig: () => OpenConfigFile(configPath),
                        onRestart: () => { restartRequested = true; cts.Cancel(); },
                        onExit: () => cts.Cancel(),
                        onCopyDiagnostics: () => CopyDiagnosticsToClipboard(BuildDiagnostics(startedAtUtc, url, trayStatus.Current, core.PendingPairCount, lastReconnectMs)))
                    : new NoOpTrayHost(msg => Console.WriteLine(msg));
            }

            connection.OnLog += msg =>
            {
                Console.WriteLine(msg);

                var lowered = msg.ToLowerInvariant();
                var isAuthSignal = lowered.Contains("connect rejected") || lowered.Contains("unauthorized") || lowered.Contains("forbidden") || lowered.Contains("auth") || lowered.Contains("token") || lowered.Contains("pre-connect-close");
                if (isAuthSignal && !authDialogShown && hasGatewayToken)
                {
                    authDialogShown = true;
                    SetTray(NodeRuntimeState.Disconnected, "Authentication failed (check token)");
                    ShowUserWarningDialog(
                        "OpenClaw Authentication Failed",
                        "The gateway rejected node authentication.\n\nPlease verify gateway.auth.token in Open Config, save, then click Restart Node.");
                }

                if (msg.Contains("Reconnecting in", StringComparison.OrdinalIgnoreCase))
                {
                    reconnectStartedAtUtc ??= DateTimeOffset.UtcNow;
                    SetTray(NodeRuntimeState.Reconnecting, msg);
                }
            };
            connection.OnConnected += () =>
            {
                Console.WriteLine("[INFO] Connected to Gateway.");
                authDialogShown = false;
                if (reconnectStartedAtUtc.HasValue)
                {
                    lastReconnectMs = (long)(DateTimeOffset.UtcNow - reconnectStartedAtUtc.Value).TotalMilliseconds;
                    reconnectStartedAtUtc = null;
                }
                SetTray(NodeRuntimeState.Connected, "Connected to Gateway");
                _ = discovery.TriggerAnnounceAsync("gateway-connected", CancellationToken.None);
            };
            connection.OnDisconnected += () =>
            {
                Console.WriteLine("[INFO] Disconnected from Gateway.");
                reconnectStartedAtUtc = DateTimeOffset.UtcNow;
                SetTray(NodeRuntimeState.Disconnected, "Disconnected from Gateway");
            };
            connection.OnConnectRejected += errorText =>
            {
                var lowered = (errorText ?? string.Empty).ToLowerInvariant();
                var isAuthIssue = lowered.Contains("token") || lowered.Contains("auth") || lowered.Contains("unauthorized") || lowered.Contains("forbidden") || lowered.Contains("invalid");
                if (!isAuthIssue || authDialogShown) return;

                authDialogShown = true;
                SetTray(NodeRuntimeState.Disconnected, "Authentication failed (check token)");
                ShowUserWarningDialog(
                    "OpenClaw Authentication Failed",
                    "Gateway rejected this node authentication.\n\nPlease verify gateway.auth.token in Open Config, save, then click Restart Node.");
            };
            ipc.OnLog += msg => Console.WriteLine(msg);
            discovery.OnLog += msg => Console.WriteLine(msg);
            connection.OnEventReceived += evt =>
            {
                if (core.HandleGatewayEvent(evt))
                {
                    Console.WriteLine($"[PAIR] pending request event handled: {evt.Event}");
                    SetTray(trayStatus.Current.State, trayStatus.Current.Message);
                }
            };

            connection.OnNodeInvoke += async req =>
            {
                Console.WriteLine($"[INVOKE] Received bridge command: {req.Command}");
                return await executor.ExecuteAsync(req);
            };

            // Register Method Handlers (Core)
            connection.RegisterMethodHandler("status", core.HandleStatusAsync);
            connection.RegisterMethodHandler("health", core.HandleHealthAsync);
            connection.RegisterMethodHandler("set-heartbeats", core.HandleSetHeartbeatsAsync);
            connection.RegisterMethodHandler("system-event", core.HandleSystemEventAsync);
            connection.RegisterMethodHandler("channels.status", core.HandleChannelsStatusAsync);
            connection.RegisterMethodHandler("config.get", core.HandleConfigGetAsync);
            connection.RegisterMethodHandler("config.schema", core.HandleConfigSchemaAsync);
            connection.RegisterMethodHandler("config.set", core.HandleConfigSetAsync);
            connection.RegisterMethodHandler("config.patch", core.HandleConfigPatchAsync);
            connection.RegisterMethodHandler("node.pair.list", core.HandleNodePairListAsync);
            connection.RegisterMethodHandler("node.pair.approve", core.HandleNodePairApproveAsync);
            connection.RegisterMethodHandler("node.pair.reject", core.HandleNodePairRejectAsync);
            connection.RegisterMethodHandler("device.pair.list", core.HandleDevicePairListAsync);
            connection.RegisterMethodHandler("device.pair.approve", core.HandleDevicePairApproveAsync);
            connection.RegisterMethodHandler("device.pair.reject", core.HandleDevicePairRejectAsync);

            if (trayHost != null)
            {
                trayStatus.OnStatusChanged += snapshot =>
                {
                    _ = trayHost.UpdateAsync(snapshot, CancellationToken.None);
                };
            }

            Console.CancelKeyPress += (s, e) =>
            {
                Console.WriteLine("Shutting down...");
                e.Cancel = true;
                cts.Cancel();
            };

            try
            {
                if (trayHost != null)
                {
                    try
                    {
                        await trayHost.StartAsync(cts.Token);
                        SetTray(NodeRuntimeState.Starting, "Starting node runtime");
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine($"[TRAY] Startup failed, continuing headless: {ex.Message}");
                        await trayHost.StopAsync();
                        trayHost = null;
                    }
                }

                if (!hasGatewayToken)
                {
                    SetTray(NodeRuntimeState.Disconnected, "Setup needed: add gateway token");
                    Console.WriteLine("[WARN] Gateway token missing. Tray mode is active; open config, set gateway.auth.token, then restart node.");
                    var details = string.IsNullOrWhiteSpace(onboarding.Details) ? string.Empty : $"\n\nDetails: {onboarding.Details}";
                    ShowUserWarningDialog(
                        title: "OpenClaw Node Setup Required",
                        message: $"{onboarding.StatusText}.\n\n{onboarding.ActionHint}.\n\nOpen tray menu → Open Config, save your changes, then click Restart Node.{details}");
                    await WaitUntilCanceledAsync(cts.Token);
                    return;
                }

                discovery.Start(cts.Token);
                ipc.Start(cts.Token);
                var runTask = connection.StartAsync(cts.Token);
                await runTask;
            }
            catch (TaskCanceledException) { }
            catch (Exception ex)
            {
                Console.WriteLine($"[FATAL] {ex.Message}");
            }
            finally
            {
                connection.Stop();
                await discovery.StopAsync();
                await ipc.StopAsync();

                if (trayHost != null)
                {
                    SetTray(NodeRuntimeState.Stopped, "Node runtime stopped");
                    await trayHost.StopAsync();
                }

                if (restartRequested)
                {
                    TryScheduleSelfRestart();
                }
            }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[FATAL] Startup failed before runtime guard: {ex.Message}");
                if (trayEnabled)
                {
                    ShowUserWarningDialog(
                        "OpenClaw Node Setup Error",
                        "Node startup failed due to invalid configuration (for example gateway URL).\n\nOpen tray menu → Open Config, fix values, save, then restart node.");
                }
            }
        }

        private static async Task WaitUntilCanceledAsync(CancellationToken cancellationToken)
        {
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (TaskCanceledException)
            {
                // expected
            }
        }

        private static string ResolveGatewayUrl(string[] args, out string? configReadError)
        {
            configReadError = null;

            var fromArgs = GetArgValue(args, "--gateway-url");
            if (!string.IsNullOrWhiteSpace(fromArgs)) return fromArgs;

            var fromEnv = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_URL");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv;

            var fromConfig = TryReadGatewayUrlFromOpenClawConfig(out configReadError);
            if (!string.IsNullOrWhiteSpace(fromConfig)) return fromConfig;

            return "ws://127.0.0.1:18789";
        }

        private static string ResolveGatewayToken(string[] args, out string? configReadError)
        {
            configReadError = null;

            var fromArgs = GetArgValue(args, "--gateway-token");
            if (!string.IsNullOrWhiteSpace(fromArgs)) return fromArgs;

            var fromEnv = Environment.GetEnvironmentVariable("OPENCLAW_GATEWAY_TOKEN");
            if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv;

            return TryReadGatewayTokenFromOpenClawConfig(out configReadError) ?? string.Empty;
        }

        private static string GetOpenClawConfigPath()
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".openclaw", "openclaw.json");
        }

        private static void OpenLogsFolder()
        {
            try
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                var dir = Path.Combine(home, ".openclaw");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = QuoteForCmd(dir),
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[TRAY] Open logs folder failed: {ex.Message}");
            }
        }

        private static void OpenConfigFile(string configPath)
        {
            try
            {
                var parent = Path.GetDirectoryName(configPath) ?? Directory.GetCurrentDirectory();
                if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);

                if (!File.Exists(configPath))
                {
                    File.WriteAllText(configPath,
                        "{\n  \"gateway\": {\n    \"host\": \"127.0.0.1\",\n    \"port\": 18789,\n    \"auth\": {\n      \"token\": \"\"\n    }\n  }\n}\n");
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = "notepad.exe",
                    Arguments = QuoteForCmd(configPath),
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[TRAY] Open config failed: {ex.Message}");
            }
        }

        private static void ShowUserWarningDialog(string title, string message)
        {
            if (!OperatingSystem.IsWindows()) return;

            try
            {
                var messageBoxType = Type.GetType("System.Windows.Forms.MessageBox, System.Windows.Forms");
                var show = messageBoxType?.GetMethod("Show", new[] { typeof(string), typeof(string) });
                if (show != null)
                {
                    show.Invoke(null, new object[] { message, title });
                    return;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[TRAY] Warning dialog failed: {ex.Message}");
            }

            Console.WriteLine($"[WARN] {title}: {message}");
        }

        private static string BuildDiagnostics(DateTimeOffset startedAtUtc, string gatewayUrl, TrayStatusSnapshot snapshot, int pendingPairs, long? lastReconnectMs)
        {
            var uptime = (long)(DateTimeOffset.UtcNow - startedAtUtc).TotalSeconds;
            var reconnectText = lastReconnectMs.HasValue ? $"{lastReconnectMs.Value}ms" : "n/a";

            return string.Join(Environment.NewLine, new[]
            {
                "OpenClaw Windows Node Diagnostics",
                $"timeUtc: {DateTimeOffset.UtcNow:O}",
                $"gatewayUrl: {gatewayUrl}",
                $"state: {snapshot.State}",
                $"message: {snapshot.Message}",
                $"pendingPairs: {pendingPairs}",
                $"onboarding: {snapshot.OnboardingStatus}",
                $"lastReconnect: {reconnectText}",
                $"uptimeSeconds: {uptime}",
                $"pid: {Environment.ProcessId}"
            });
        }

        private static void CopyDiagnosticsToClipboard(string text)
        {
            if (!OperatingSystem.IsWindows())
            {
                Console.WriteLine("[TRAY] Copy diagnostics skipped on non-Windows host.");
                return;
            }

            try
            {
                var escaped = text.Replace("'", "''");
                Process.Start(new ProcessStartInfo
                {
                    FileName = "powershell",
                    Arguments = $"-NoProfile -ExecutionPolicy Bypass -Command \"Set-Clipboard -Value '{escaped}'\"",
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
                Console.WriteLine("[TRAY] Diagnostics copied to clipboard.");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[TRAY] Copy diagnostics failed: {ex.Message}");
            }
        }

        private static void TryScheduleSelfRestart(int delaySeconds = 1)
        {
            try
            {
                var processPath = Environment.ProcessPath;
                if (string.IsNullOrWhiteSpace(processPath))
                {
                    Console.WriteLine("[TRAY] Restart requested but process path is unavailable.");
                    return;
                }

                delaySeconds = Math.Clamp(delaySeconds, 1, 120);

                var args = Environment.GetCommandLineArgs();
                var argBuilder = new System.Text.StringBuilder();
                for (var i = 1; i < args.Length; i++)
                {
                    if (argBuilder.Length > 0) argBuilder.Append(' ');
                    argBuilder.Append(QuoteForCmd(args[i]));
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = $"/c timeout /t {delaySeconds} /nobreak >nul && start \"\" {QuoteForCmd(processPath)} {argBuilder} && taskkill /PID {Environment.ProcessId} /F",
                    UseShellExecute = false,
                    CreateNoWindow = true
                });

                Console.WriteLine($"[TRAY] Restart scheduled in {delaySeconds}s.");
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[TRAY] Failed to schedule restart: {ex.Message}");
            }
        }

        private static string QuoteForCmd(string value)
        {
            if (string.IsNullOrEmpty(value)) return "\"\"";
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static bool HasArg(string[] args, string key)
        {
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static string? GetArgValue(string[] args, string key)
        {
            for (var i = 0; i < args.Length - 1; i++)
            {
                if (args[i].Equals(key, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            }
            return null;
        }

        private static string? TryReadGatewayUrlFromOpenClawConfig(out string? error)
        {
            error = null;

            if (!TryReadGatewaySection(out var gateway, out error)) return null;
            return BuildGatewayUrlFromGatewaySection(gateway, out error);
        }

        internal static string? BuildGatewayUrlFromGatewaySection(JsonElement gateway, out string? error)
        {
            error = null;

            var host = "127.0.0.1";
            if (gateway.TryGetProperty("host", out var hostEl))
            {
                if (hostEl.ValueKind != JsonValueKind.String)
                {
                    error = "gateway.host must be a string";
                    return null;
                }

                var configuredHost = hostEl.GetString();
                if (string.IsNullOrWhiteSpace(configuredHost))
                {
                    error = "gateway.host must not be empty";
                    return null;
                }

                host = configuredHost.Trim();
            }

            var port = 18789;
            if (gateway.TryGetProperty("port", out var portEl))
            {
                if (portEl.ValueKind != JsonValueKind.Number)
                {
                    error = "gateway.port must be numeric";
                    return null;
                }

                if (!portEl.TryGetInt32(out var parsedPort))
                {
                    error = "gateway.port must be an integer in range 1..65535";
                    return null;
                }

                if (parsedPort is < 1 or > 65535)
                {
                    error = "gateway.port must be in range 1..65535";
                    return null;
                }

                port = parsedPort;
            }

            var normalizedHost = host.Contains(':') && !(host.StartsWith("[") && host.EndsWith("]"))
                ? $"[{host}]"
                : host;

            return $"ws://{normalizedHost}:{port}";
        }

        private static string? TryReadGatewayTokenFromOpenClawConfig(out string? error)
        {
            error = null;

            if (!TryReadGatewaySection(out var gateway, out error)) return null;
            if (!gateway.TryGetProperty("auth", out var auth))
            {
                error = "gateway.auth section missing";
                return null;
            }

            if (!auth.TryGetProperty("token", out var tokenEl))
            {
                error = "gateway.auth.token missing";
                return null;
            }

            if (tokenEl.ValueKind != JsonValueKind.String)
            {
                error = "gateway.auth.token must be a string";
                return null;
            }

            return tokenEl.GetString();
        }

        private static bool TryReadGatewaySection(out JsonElement gateway, out string? error)
        {
            gateway = default;
            error = null;

            var path = GetOpenClawConfigPath();
            if (!File.Exists(path))
            {
                return false;
            }

            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(path));
                if (!doc.RootElement.TryGetProperty("gateway", out var gw))
                {
                    error = "gateway section missing";
                    return false;
                }

                gateway = gw.Clone();
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }
    }
}
