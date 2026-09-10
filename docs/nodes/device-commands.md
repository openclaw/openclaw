---
summary: "CLI helpers for the widget panel, camera, screen, location, SMS, and device data"
read_when:
  - Capturing a photo, clip, or screen recording from a node
  - Reading location, SMS, or device data from a node
  - Presenting a hosted widget on a Mac
title: "Node device commands"
sidebarTitle: "Device commands"
---

## macOS widget panel

```bash
openclaw nodes canvas present --node <idOrNameOrIp>
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate "/__openclaw__/canvas/documents/<document-id>/index.html" --node <idOrNameOrIp>
```

Notes:

- `canvas present` accepts the existing optional target plus
  `--x/--y/--width/--height` placement arguments.
- `canvas navigate` accepts a hosted widget-document path or an app-local
  Canvas URL. The macOS app resolves hosted paths through its current scoped
  Canvas capability URL.
- The agent-facing path is [`show_widget`](/tools/show-widget) with
  `presentation.target: "node_panel"`; use the CLI helpers for direct operator
  control.
- A2UI renders on [session dashboards](/web/dashboards), not through node
  Canvas commands.

## Photos + videos (node camera)

Photos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: one node-selected photo
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
openclaw nodes camera snap --node <idOrNameOrIp> --facing both # front then back (2 saved paths)
openclaw nodes camera snap --node <idOrNameOrIp> --device-id <id> --max-width 1200 --quality 0.9 --delay-ms 2000
```

Video clips (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:

- The node must be **foregrounded** for `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Nodes clamp clip duration to keep the base64 payload manageable (see [Camera capture](/nodes/camera) for exact per-platform limits). The `nodes` agent tool additionally caps requested `durationMs` at 300000 (5 minutes) before forwarding the call; the node itself enforces the tighter limit.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Supported nodes expose `screen.record` (mp4). Example:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes:

- `screen.record` availability depends on node platform.
- The `nodes` agent tool caps requested `durationMs` at 300000 (5 minutes); the node may enforce a tighter limit to bound the returned payload.
- `--no-audio` disables microphone capture on supported platforms.
- Use `--screen <index>` to select a display when multiple screens are available (0 = primary).

## Location (nodes)

Nodes expose `location.get` when Location is enabled in settings.

CLI helper:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes:

- Location is **off by default**.
- "Always" requires system permission; background fetch is best-effort.
- The response includes lat/lon, accuracy (meters), and timestamp.
- Full parameter/response shape and error codes: [Location command](/nodes/location-command).

## SMS (Android nodes)

Android nodes can expose `sms.send` and `sms.search` when the user grants **SMS** permission and the device supports telephony. Both commands are dangerous-by-default: the gateway operator must also add them to `gateway.nodes.commands.allow` before they can be invoked (see [Command policy](/nodes/command-policy#command-policy)).

For read-only SMS search, opt in explicitly in `openclaw.json`:

```json5
{
  gateway: {
    nodes: {
      commands: { allow: ["sms.search"] },
    },
  },
}
```

Add `sms.send` separately only when the node should also be able to send messages. Android permission and Gateway command authorization are independent; granting the phone permission does not edit Gateway policy.

Low-level invoke:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notes:

- `sms.search` may be declared before `READ_SMS` is granted so an invocation can return a permission diagnostic; reading messages still requires that Android permission.
- Wi-Fi-only devices without telephony will not advertise `sms.send`.
- A `requires explicit gateway.nodes.commands.allow opt-in` error means the phone declared the command but the Gateway operator has not authorized it.

## Device and personal data commands

iOS and Android nodes advertise several read-only data commands by default (see the [Command policy](/nodes/command-policy#command-policy) table); Android additionally exposes a larger family gated by its own in-app settings. A macOS or headless-mac TypeScript node host advertises `device.apps` only after the operator enables installed-app sharing with `--share-installed-apps`.

Available families:

- `device.status`, `device.info` — iOS, Android, Windows.
- `device.permissions`, `device.health` — Android only.
- `device.apps` — Android, macOS, and headless-mac nodes. Android requires Installed Apps sharing in Settings and returns launcher-visible apps by default. TypeScript node hosts keep sharing off by default and accept `query`, `limit`, and `includeSystem`; macOS results contain `label`, `bundleId`, `path`, and `system`.
- `notifications.list`, `notifications.actions` — Android only.
- `photos.latest` — iOS, Android.
- `contacts.search` — iOS, Android (read-only default); `contacts.add` is dangerous and needs `gateway.nodes.commands.allow`.
- `calendar.events` — iOS, Android (read-only default); `calendar.add` is dangerous and needs `gateway.nodes.commands.allow`.
- `reminders.list` — iOS, Android (read-only default); `reminders.add` is dangerous and needs `gateway.nodes.commands.allow`.
- `callLog.search` — Android only.
- `motion.activity`, `motion.pedometer` — iOS, Android; capability-gated by available sensors.

Example invokes:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command device.status --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command device.apps --params '{"limit":10}'
openclaw nodes invoke --node <idOrNameOrIp> --command notifications.list --params '{}'
openclaw nodes invoke --node <idOrNameOrIp> --command photos.latest --params '{"limit":1}'
```
