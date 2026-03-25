using Microsoft.Extensions.Hosting;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using OpenClawWindows.Application;
using OpenClawWindows.Application.Ports;
using OpenClawWindows.Domain.Settings;
using OpenClawWindows.Infrastructure;
using OpenClawWindows.Infrastructure.Observability;
using OpenClawWindows.Presentation;
using OpenClawWindows.Presentation.Tray;
using OpenClawWindows.Presentation.ViewModels;
using OpenClawWindows.Presentation.Windows;
using Serilog.Core;
using Serilog.Events;

namespace OpenClawWindows;

/// <summary>
/// OpenClaw Windows node — exposes device capabilities to AI agents via WebSocket gateway.
/// Equivalent to AppState.swift + AppDelegate in the macOS reference implementation.
/// </summary>
public partial class App : Microsoft.UI.Xaml.Application
{
    private static readonly string DiagLog = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OpenClaw", "diag.log");

    // Controls the file sink level at runtime — toggled via ToggleFileLogging in the debug menu.
    internal static readonly LoggingLevelSwitch FileLevelSwitch = new(LogEventLevel.Information);

    private IHost _host = null!;
    private Window? _keepAliveWindow;

    public App()
    {
        WriteDiag("App() — constructor start");

        this.UnhandledException += (_, e) =>
        {
            WriteDiag($"UnhandledException: {e.Exception?.GetType().Name}: {e.Exception?.Message}");
            WriteDiag($"  StackTrace: {e.Exception?.StackTrace}");
            WriteDiag($"  InnerException: {e.Exception?.InnerException}");
            e.Handled = true;
        };

        try
        {
            _host = Host.CreateDefaultBuilder()
                .ConfigureAppConfiguration(config =>
                {
                    var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                    config.AddJsonFile(
                        Path.Combine(appData, "OpenClaw", "appsettings.json"),
                        optional: true,
                        reloadOnChange: true);
                })
                .ConfigureServices((ctx, services) =>
                {
                    services.AddSingleton(FileLevelSwitch);
                    services.AddApplication();
                    services.AddInfrastructure();
                    services.AddPresentation();
                })
                .UseSerilog((_, log) =>
                {
                    var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                    log.WriteTo.File(
                        Path.Combine(appData, "OpenClaw", "logs", "openclaw-.log"),
                        rollingInterval: RollingInterval.Day,
                        retainedFileCountLimit: 7,
                        levelSwitch: FileLevelSwitch,
                        outputTemplate: "{Timestamp:yyyy-MM-dd HH:mm:ss.fff zzz} [{Level:u3}] {SourceContext}: {Message:lj}{NewLine}{Exception}");
                })
                .Build();

            WriteDiag("App() — host built OK");
        }
        catch (Exception ex)
        {
            WriteDiag($"App() — host build FAILED: {ex}");
            throw;
        }

        SerilogConfiguration.Initialize();
        WriteDiag("App() — Serilog initialized");

        try
        {
            this.InitializeComponent();
            WriteDiag("App() — InitializeComponent OK");
        }
        catch (Exception ex)
        {
            WriteDiag($"App() — InitializeComponent FAILED: {ex}");
        }
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        WriteDiag("OnLaunched — start");

        try
        {
            // When the host stops (e.g. QuitApplicationCommand), exit the WinUI app loop.
            var dispatcher = Microsoft.UI.Dispatching.DispatcherQueue.GetForCurrentThread();
            _host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.Register(() =>
            {
                WriteDiag("ApplicationStopping — calling Application.Exit()");
                dispatcher.TryEnqueue(() => Exit());
            });

            await _host.StartAsync();
            WriteDiag("OnLaunched — host started");

            // Keep-alive window: invisible, off-screen, prevents WinUI runtime from
            // shutting down when the last visible window closes. Required for tray-only apps.
            _keepAliveWindow = new Window();
            _keepAliveWindow.Content = new Grid();
            _keepAliveWindow.AppWindow.IsShownInSwitchers = false;
            _keepAliveWindow.AppWindow.MoveAndResize(
                new Windows.Graphics.RectInt32(-32000, -32000, 1, 1));
            WriteDiag("OnLaunched — keep-alive window created");

            // App lives in the system tray — no main window shown on launch.
            _host.Services.GetRequiredService<TrayIconPresenter>().Show();
            WriteDiag("OnLaunched — tray icon shown");

            // Show onboarding wizard on first run — mirrors scheduleFirstRunOnboardingIfNeeded() in MenuBar.swift.
            await ScheduleFirstRunOnboardingIfNeededAsync();
        }
        catch (Exception ex)
        {
            WriteDiag($"OnLaunched — FAILED: {ex}");
        }
    }

    // Mirrors scheduleFirstRunOnboardingIfNeeded() in MenuBar.swift (macOS).
    // Shows the full OnboardingWindow on first run — Welcome → Connection → (Wizard) → Ready.
    // finish() inside OnboardingFlowViewModel sets OnboardingSeen=true on completion.
    private async Task ScheduleFirstRunOnboardingIfNeededAsync()
    {
        try
        {
            var settings = await _host.Services.GetRequiredService<ISettingsRepository>()
                .LoadAsync(CancellationToken.None);

            WriteDiag($"Settings loaded: OnboardingSeen={settings.OnboardingSeen} ConnectionMode={settings.ConnectionMode} path={System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "OpenClaw", "settings.json")}");

            if (settings.OnboardingSeen)
            {
                WriteDiag("Onboarding already seen — skipping");
                return;
            }

            WriteDiag("First run — showing onboarding window");
            var vm = _host.Services.GetRequiredService<OnboardingFlowViewModel>();
            await vm.InitializeAsync(CancellationToken.None);
            var window = new OnboardingWindow(vm);
            window.Activate();
            WriteDiag("Onboarding window activated");
        }
        catch (Exception ex)
        {
            WriteDiag($"ScheduleFirstRunOnboarding — FAILED: {ex}");
        }
    }

    private static void WriteDiag(string msg)
    {
        try
        {
            var dir = Path.GetDirectoryName(DiagLog)!;
            Directory.CreateDirectory(dir);
            File.AppendAllText(DiagLog, $"[{DateTime.Now:HH:mm:ss.fff}] {msg}{Environment.NewLine}");
        }
        catch
        {
            // Best-effort diagnostic logging — never crash the app.
        }
    }
}
