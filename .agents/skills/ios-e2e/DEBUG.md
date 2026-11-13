# iOS debugging and profiling

For the [iOS E2E loop](SKILL.md); `$sim` and `$bundle` are defined there.

## LLDB

```sh
mobilebuildmcp debugging attach --bundle-id "$bundle" --continue-on-attach --simulator-id "$sim"
mobilebuildmcp debugging add-breakpoint --function 'GatewayStatusBuilder.build'
mobilebuildmcp debugging stack
mobilebuildmcp debugging lldb-command --command 'expression -l swift -- appModel.gatewayStatusText'
mobilebuildmcp debugging continue && mobilebuildmcp debugging detach
```

UI automation is blocked while LLDB holds the app paused; continue first.

## Profile with xctrace

1. PID: `pgrep -f "CoreSimulator/Devices/$sim/.*/OpenClaw.app/OpenClaw"`; attaching by process name fails.
2. Record in the background while driving the UI: `xcrun xctrace record --template 'Time Profiler' --device "$sim" --attach <pid> --time-limit 10s --output /tmp/<name>.trace`.
3. Export: `xcrun xctrace export --input /tmp/<name>.trace --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-profile"]'`. An idle app records zero rows.

Simulator timings compare builds; they do not show real-device speed. Hitches, the SwiftUI instrument and energy need a physical device.
