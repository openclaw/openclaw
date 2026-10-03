## Unreleased

### Fixes

- Gateway: release agent-database leases left behind by a previous boot on Linux hosts that hide other processes (Android, `hidepid` procfs mounts, containers, systemd `ProtectProc=`). A reused PID answered the liveness probe with EPERM and no readable `/proc/<pid>/stat`, so the stale lease looked alive forever and the Gateway refused to open the agent database. Each lease now records the kernel boot ID, and a lease from a different boot is stale before any PID probe.
