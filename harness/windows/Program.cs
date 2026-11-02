using System;
using System.Diagnostics;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Windows.ApplicationModel.DynamicDependency;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var version = Version.Parse(args[0]);
        var majorMinor = ((uint)version.Major << 16) | (ushort)version.Minor;
        const string versionTag = "";
        using var identity = WindowsIdentity.GetCurrent();
        try
        {
            WinRT.ComWrappersSupport.InitializeComWrappers();
            Bootstrap.Initialize(majorMinor, versionTag);
            Console.WriteLine(JsonSerializer.Serialize(new { status = "passed", version = args[0], majorMinor, versionTag,
                user = identity.Name, sid = identity.User?.Value, sessionId = Process.GetCurrentProcess().SessionId,
                bootstrapAssembly = typeof(Bootstrap).Assembly.Location, processId = Environment.ProcessId }));
            Bootstrap.Shutdown();
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(JsonSerializer.Serialize(new { status = "failed", version = args[0], majorMinor, versionTag,
                user = identity.Name, sid = identity.User?.Value, sessionId = Process.GetCurrentProcess().SessionId,
                hresult = error.HResult, error = error.ToString() }));
            return 1;
        }
    }
}