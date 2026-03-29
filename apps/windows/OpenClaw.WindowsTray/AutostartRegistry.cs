using Microsoft.Win32;
using System.Reflection;

namespace OpenClaw.WindowsTray;

internal static class AutostartRegistry
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "OpenClaw Windows Companion";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        var value = key?.GetValue(ValueName) as string;
        return !string.IsNullOrWhiteSpace(value);
    }

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
        if (key is null)
        {
            throw new InvalidOperationException("Could not open the Windows Run registry key.");
        }

        if (enabled)
        {
            key.SetValue(ValueName, BuildLaunchCommand(), RegistryValueKind.String);
            return;
        }

        key.DeleteValue(ValueName, throwOnMissingValue: false);
    }

    private static string BuildLaunchCommand()
    {
        var processPath = Environment.ProcessPath;
        var entryAssemblyPath = Assembly.GetEntryAssembly()?.Location;

        if (
            !string.IsNullOrWhiteSpace(processPath)
            && processPath.EndsWith("dotnet.exe", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(entryAssemblyPath)
            && entryAssemblyPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
        )
        {
            return $"{Quote(processPath)} {Quote(entryAssemblyPath)}";
        }

        if (!string.IsNullOrWhiteSpace(processPath))
        {
            return Quote(processPath);
        }

        if (!string.IsNullOrWhiteSpace(entryAssemblyPath))
        {
            if (entryAssemblyPath.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            {
                return $"{Quote("dotnet")} {Quote(entryAssemblyPath)}";
            }

            return Quote(entryAssemblyPath);
        }

        throw new InvalidOperationException("Could not determine the tray app launch command.");
    }

    private static string Quote(string value)
    {
        return value.Contains(' ') ? $"\"{value}\"" : value;
    }
}
