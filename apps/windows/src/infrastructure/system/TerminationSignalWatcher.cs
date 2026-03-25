using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.UI.Dispatching;

namespace OpenClawWindows.Infrastructure.Lifecycle;

/// <summary>
/// Installs handlers for SIGTERM and SIGINT to enable graceful shutdown.
/// </summary>
internal sealed class TerminationSignalWatcher : IHostedService, IDisposable
{
    private readonly ILogger<TerminationSignalWatcher> _logger;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly List<PosixSignalRegistration> _registrations = [];

    private int _terminationRequested; // 0 = false, 1 = true; guarded by Interlocked
    private DispatcherQueue? _dispatcherQueue;

    // Tunables
    private const int SafetyNetMs = 3_000; // 3 s safety net after graceful shutdown begins

    // Internal seam: allows tests to replace Environment.Exit(0) with a no-op.
    internal Action<int> TerminateProcess { get; init; } = Environment.Exit;

    // Internal for testing — reports how many signal registrations are active.
    internal int RegistrationCount => _registrations.Count;

    public TerminationSignalWatcher(
        ILogger<TerminationSignalWatcher> logger,
        IHostApplicationLifetime lifetime)
    {
        _logger = logger;
        _lifetime = lifetime;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        // Capture the UI-thread dispatcher here; StartAsync runs on the main thread.
        try { _dispatcherQueue = DispatcherQueue.GetForCurrentThread(); }
        catch { _dispatcherQueue = null; }
        Start();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        Stop();
        return Task.CompletedTask;
    }

    internal void Start()
    {
        if (_registrations.Count > 0) return;
        Install(PosixSignal.SIGTERM);
        Install(PosixSignal.SIGINT);
    }

    internal void Stop()
    {
        foreach (var r in _registrations) r.Dispose();
        _registrations.Clear();
        Interlocked.Exchange(ref _terminationRequested, 0);
    }

    private void Install(PosixSignal signal)
    {
        // Cancel the default OS signal action so the process survives long enough
        // to run the graceful shutdown path.
        var registration = PosixSignalRegistration.Create(signal, ctx =>
        {
            ctx.Cancel = true;
            Handle((int)signal);
        });
        _registrations.Add(registration);
    }

    internal void Handle(int sig)
    {
        if (Interlocked.CompareExchange(ref _terminationRequested, 1, 0) != 0) return;

        _logger.LogInformation("received signal {Signal}; terminating", sig);

        // Stop all hosted services (includes pairing orchestrators), preventing any
        // in-flight approval dialogs from completing during shutdown.
        //             + DevicePairingApprovalPrompter.shared.stop().
        _lifetime.StopApplication();

        // Terminate the WinUI application on the UI thread.
        _dispatcherQueue?.TryEnqueue(
            () => Microsoft.UI.Xaml.Application.Current?.Exit());

        // Safety net: don't hang forever if something blocks termination.
        _ = Task.Delay(SafetyNetMs).ContinueWith(_ => TerminateProcess(0));
    }

    public void Dispose() => Stop();
}
