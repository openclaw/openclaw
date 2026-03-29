using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace OpenClaw.WindowsTray;

internal static class Program
{
    private const int AttachParentProcess = -1;

    [STAThread]
    private static int Main(string[] args)
    {
        if (TryGetJsonOutputPath(args, out var outputPath))
        {
            AttachParentConsole();
            if (args.Any(arg => string.Equals(arg, "--smoke", StringComparison.OrdinalIgnoreCase)))
            {
                var smoke = GatewayCli.RunSmokeAsync().GetAwaiter().GetResult();
                WriteJsonResult(outputPath!, smoke);
                return smoke.Ok ? 0 : 1;
            }

            if (args.Any(arg => string.Equals(arg, "--status-json", StringComparison.OrdinalIgnoreCase)))
            {
                var snapshot = GatewayCli.GetStatusAsync().GetAwaiter().GetResult();
                WriteJsonResult(outputPath!, new
                {
                    state = snapshot.State.ToString().ToLowerInvariant(),
                    snapshot.Summary,
                    snapshot.Details,
                    snapshot.LogsDirectory,
                    snapshot.ConfigDirectory,
                    snapshot.RecommendedAction,
                });
                return 0;
            }

            var lifecycleAction = TryGetOptionValue(args, "--lifecycle-json");
            if (!string.IsNullOrWhiteSpace(lifecycleAction))
            {
                var result = GatewayCli.RunLifecycleAsync(lifecycleAction).GetAwaiter().GetResult();
                WriteJsonResult(outputPath!, result);
                return result.Ok ? 0 : 1;
            }
        }

        if (args.Any(arg => string.Equals(arg, "--smoke", StringComparison.OrdinalIgnoreCase)))
        {
            AttachParentConsole();
            var smoke = GatewayCli.RunSmokeAsync().GetAwaiter().GetResult();
            var smokeJson = JsonSerializer.Serialize(smoke);
            outputPath = TryGetOptionValue(args, "--smoke-output");
            if (!string.IsNullOrWhiteSpace(outputPath))
            {
                File.WriteAllText(outputPath, smokeJson);
            }
            Console.WriteLine(smokeJson);
            return smoke.Ok ? 0 : 1;
        }

        using var singleInstanceMutex = new Mutex(true, "OpenClaw.WindowsTray.Singleton", out var createdNew);
        if (!createdNew)
        {
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext(args));
        GC.KeepAlive(singleInstanceMutex);
        return 0;
    }

    private static void AttachParentConsole()
    {
        if (!AttachConsole(AttachParentProcess))
        {
            return;
        }

        var stdout = new StreamWriter(Console.OpenStandardOutput())
        {
            AutoFlush = true,
        };
        Console.SetOut(stdout);

        var stderr = new StreamWriter(Console.OpenStandardError())
        {
            AutoFlush = true,
        };
        Console.SetError(stderr);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(int dwProcessId);

    private static bool TryGetJsonOutputPath(string[] args, out string? outputPath)
    {
        outputPath = TryGetOptionValue(args, "--output");
        return !string.IsNullOrWhiteSpace(outputPath);
    }

    private static void WriteJsonResult<T>(string outputPath, T payload)
    {
        var parent = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrWhiteSpace(parent))
        {
            Directory.CreateDirectory(parent);
        }
        var json = JsonSerializer.Serialize(payload);
        File.WriteAllText(outputPath, json);
        Console.WriteLine(json);
    }

    private static string? TryGetOptionValue(string[] args, string optionName)
    {
        for (var i = 0; i < args.Length - 1; i += 1)
        {
            if (string.Equals(args[i], optionName, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }

        return null;
    }
}
