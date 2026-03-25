using Microsoft.Extensions.Hosting;

namespace OpenClawWindows.Infrastructure.Lifecycle;

// Replaces ConsoleLifetime (added by Host.CreateDefaultBuilder) which blocks in WinExe apps.
// ConsoleLifetime.WaitForStartAsync() calls Console.CancelKeyPress += which internally
// invokes SetConsoleCtrlHandler via ConsolePal — this hangs when no console is attached.
// Termination is handled instead by TerminationSignalWatcher (SIGTERM/SIGINT) and
// App.Exit() on the WinUI3 dispatcher.
internal sealed class WinUiHostLifetime : IHostLifetime
{
    public Task WaitForStartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
