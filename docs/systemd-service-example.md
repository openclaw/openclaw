# systemd WatchdogSec Integration

OpenClaw supports systemd's `Type=notify` and `WatchdogSec` integration. This allows systemd to monitor the gateway's health and automatically restart it if it becomes unresponsive.

## Systemd Service Configuration

To enable this integration, add the following settings to your `openclaw.service` unit file:

```ini
[Unit]
Description=OpenClaw Gateway
After=network.target

[Service]
ExecStart=/usr/bin/openclaw gateway start
# Enable systemd notification support
Type=notify
# Restart the service if it doesn't send a watchdog heartbeats for 90 seconds
WatchdogSec=90
# Ensure the service can send notifications
NotifyAccess=all
Restart=always

[Install]
WantedBy=multi-user.target
```

## How it works

1.  **Readiness**: When the gateway finishes starting up and is ready to accept connections, it sends `READY=1` to systemd.
2.  **Watchdog**: Every time the internal maintenance timer "ticks" (configured by `TICK_INTERVAL_MS`), the gateway sends `WATCHDOG=1` to systemd to reset the watchdog timer.
3.  **Automatic Restart**: If the gateway process hangs (e.g., event loop starvation) and fails to send the watchdog signal within the `WatchdogSec` interval, systemd will kill and restart the service.
