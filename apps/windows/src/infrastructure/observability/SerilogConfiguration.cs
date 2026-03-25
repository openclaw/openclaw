using Serilog;

namespace OpenClawWindows.Infrastructure.Observability;

// Global Serilog bootstrap — called once at app startup after the host is built.
// Ensures Log.Logger is set so any code using static Serilog.Log calls works correctly.
public static class SerilogConfiguration
{
    public static void Initialize()
    {
        // Host.UseSerilog() has already configured the global Log.Logger via the
        // callback in App.xaml.cs — this is a no-op guard for call ordering safety.
        if (Log.Logger is Serilog.Core.Logger)
            return;

        Log.Logger = new LoggerConfiguration()
            .WriteTo.File(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "OpenClaw", "logs", "fallback.log"),
                rollingInterval: Serilog.RollingInterval.Day)
            .CreateLogger();
    }
}
