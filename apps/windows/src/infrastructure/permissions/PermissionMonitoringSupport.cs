namespace OpenClawWindows.Infrastructure.Permissions;

// Helper for managing PermissionMonitor.Shared registration lifecycle.
internal static class PermissionMonitoringSupport
{
    public static void SetMonitoring(bool shouldMonitor, ref bool monitoring)
    {
        if (shouldMonitor && !monitoring)
        {
            monitoring = true;
            PermissionMonitor.Shared.Register();
        }
        else if (!shouldMonitor && monitoring)
        {
            monitoring = false;
            PermissionMonitor.Shared.Unregister();
        }
    }

    public static void StopMonitoring(ref bool monitoring)
    {
        if (!monitoring) return;
        monitoring = false;
        PermissionMonitor.Shared.Unregister();
    }
}
