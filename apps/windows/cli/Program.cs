// Mirrors EntryPoint.swift: @main struct OpenClawMacCLI — dispatches to Connect/Discover/Wizard.
namespace OpenClawWindows.CLI;

internal static class Program
{
    private static async Task Main(string[] args)
    {
        if (args.Length == 0) { PrintUsage(); return; }

        var command = args[0];
        var rest = args[1..];

        switch (command)
        {
            case "-h":
            case "--help":
            case "help":
                PrintUsage();
                break;
            case "connect":
                await ConnectCommand.RunAsync(rest);
                break;
            case "discover":
                await DiscoverCommand.RunAsync(rest);
                break;
            case "wizard":
                await WizardCommand.RunAsync(rest);
                break;
            default:
                Console.Error.WriteLine("openclaw-win: unknown command");
                PrintUsage();
                Environment.Exit(1);
                break;
        }
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            openclaw-win

            Usage:
              openclaw-win connect [--url <ws://host:port>] [--token <token>] [--password <password>]
                                   [--mode <local|remote>] [--timeout <ms>] [--probe] [--json]
                                   [--client-id <id>] [--client-mode <mode>] [--display-name <name>]
                                   [--role <role>] [--scopes <a,b,c>]
              openclaw-win discover [--timeout <ms>] [--json] [--include-local]
              openclaw-win wizard [--url <ws://host:port>] [--token <token>] [--password <password>]
                                  [--mode <local|remote>] [--workspace <path>] [--json]

            Examples:
              openclaw-win connect
              openclaw-win connect --url ws://127.0.0.1:18789 --json
              openclaw-win discover --timeout 3000 --json
              openclaw-win wizard --mode local
            """);
    }
}
