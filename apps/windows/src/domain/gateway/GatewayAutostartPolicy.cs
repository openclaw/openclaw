using OpenClawWindows.Domain.Settings;

namespace OpenClawWindows.Domain.Gateway;

// Pure policy: determines when the gateway process should be started or kept alive.
public static class GatewayAutostartPolicy
{
    // gateway runs only in local mode when not paused.
    public static bool ShouldStartGateway(ConnectionMode mode, bool paused) =>
        mode == ConnectionMode.Local && !paused;

    // on Windows this means ensuring the
    // Task Scheduler autostart entry exists; logic is identical to ShouldStartGateway.
    public static bool ShouldEnsureAutostart(ConnectionMode mode, bool paused) =>
        ShouldStartGateway(mode, paused);
}
