---
summary: "Detect the Mac you most recently used and route node alerts there"
read_when:
  - You want OpenClaw to identify the active Mac
  - You are debugging last-input activity or active-node selection
  - You want to understand node connection notification routing
title: "Active computer presence"
---

Active computer presence tells the Gateway which connected macOS node received
the most recent activity. Basic presence works when you interact with the
OpenClaw app, without extra permissions. Optional **System-wide presence
detection** also includes physical mouse and keyboard activity in other apps.
OpenClaw uses that signal to mark one Mac as `active`, give the agent a stable
active-node hint, and route node connection alerts to the computer where you
are most likely present.

This is a recent-activity hint, not proof of which computer sent a particular
chat message. The active Mac can differ from the computer running the Gateway
or agent. Device status and connection-alert routing select the freshest eligible
Mac across the Gateway. The agent's prompt hint instead selects among nodes
associated with the authenticated requester. It never falls back to another
person's machine. Shared-owner and unidentified turns can receive an unassigned
node hint, explicitly marked with unknown person identity.

The core [presence tool](/concepts/presence#ask-the-agent-about-presence) combines
these observations with the live roster of people and clients. It preserves the
activity source and identifies shared or unassigned machines separately.
Durable `node.presence.alive` beacons record when a mobile node last woke without
treating it as connected or establishing user activity.

## Requirements

- The OpenClaw macOS app is paired and connected in node mode.
- Interact with the OpenClaw app to provide basic presence. Merely running or
  foregrounding the app does not count as activity.
- To include activity in other apps, enable **Settings -> Permissions ->
  System-wide presence detection** and grant **Accessibility** to the signed
  OpenClaw app. System-wide detection is off by default.
- For connection alerts, **Notifications** permission is also granted and the
  Mac node exposes `system.notify`.

Activity reporting is implemented only by the native macOS node. iOS,
Android, watchOS, and headless node hosts can report connection or background
last-seen state, but they do not compete for the active-computer designation.

## Check the active computer

1. Interact with the OpenClaw macOS app. No Accessibility permission is needed
   for this basic presence signal. To detect activity in other apps too, enable
   **Settings -> Permissions -> System-wide presence detection** and grant
   **Accessibility** in macOS System Settings.
2. Confirm the Mac node is connected:

   ```bash
   openclaw nodes status --connected
   ```

3. Click or type in OpenClaw on that Mac, then run:

   ```bash
   openclaw nodes status
   openclaw nodes describe --node <node-id-or-name>
   ```

The freshest eligible Mac is marked `active`. Status output shows its last-input
age; `describe` exposes `active`, `lastActiveAtMs`, and `presenceUpdatedAtMs`.
Activity is intentionally coalesced, so the display may take up to about 15
seconds to reflect another input after a recent report.

## How activity becomes presence

The macOS app records local input events received by OpenClaw. When system-wide
detection is enabled and Accessibility is granted, it also samples the HID
system idle clock every two seconds. Reports are coalesced: newer activity is
sent no more than once every 15 seconds, with a keepalive every three minutes
while idle. Idle duration is capped at 30 days so a very old sample cannot drift
forward and incorrectly become the newest computer.

Disabling **System-wide presence detection**, or losing Accessibility, clears
the previous system-wide sample and falls back to app-local activity if any has
been observed. It does not turn off basic presence or disconnect other node
capabilities. Without an app-local sample, that Mac remains unselected until
you interact with OpenClaw.

The Gateway accepts activity only when all of these are true:

- the event belongs to the current authenticated connection for that node id;
- the payload contains a bounded integer `idleSeconds` value;
- the source is app-local, or system-wide with effective `accessibility: true`
  permission. Legacy reports without a source are treated as system-wide.

The Gateway subtracts `idleSeconds` from its own observation time to derive
`lastActiveAtMs`. It never trusts a node-supplied wall-clock timestamp. Among
connected eligible Macs, the newest `lastActiveAtMs` wins; a tie uses the most
recent presence update.

Presence is process-local and connection-bound. Disconnecting the current
session or replacing it with another session using the same node id clears that
node's activity state and recomputes the active Mac. Revoking Accessibility
invalidates system-wide activity, but app-local activity remains eligible.

## Privacy and model context

Basic app-local presence is available without an Accessibility grant. Only
system-wide detection is opt-in, separately from the Accessibility grant used
for UI automation. OpenClaw sends idle duration and the activity source, not
input content. It does not send key values, mouse coordinates, application
names, window titles, or raw input events.

System-wide detection reads the hardware HID state, so synthetic
computer-control events do not count as physical system-wide activity.
App-local detection records input delivered to OpenClaw and is not proof that
an event came from a physical device.

Continuous activity does not create model-facing system events. At turn
preparation, the dynamic context contains a compact hint with only the
authenticated node id:

```text
active_node=<node-id> active_node_identity=requester
```

When no eligible connected Mac has current presence, the hint is
`active_node=unknown`. This clears a previous selection rather than leaving the
agent to reuse a disconnected Mac. It does not identify the message's source
device or imply that no one is using a computer.

For shared-owner or unidentified turns the identity marker is
`active_node_identity=unknown`; activity on that machine does not establish who
used it. A named person's hint requires a matching authenticated node profile.
Device names, IP addresses, and a single visible person cannot establish that
association.

Exact timestamps and node-controlled display names stay out of the prompt to
avoid prompt injection and cache churn. The hint stays byte-for-byte identical
while the selected node id is unchanged. When the agent needs current details,
the `presence` tool can inspect the requester and their devices. The `nodes`
tool continues to read device status and control capabilities through
`node.list` or `node.describe`.

## How connection alerts are routed

After a node finishes its first successful Gateway handshake after approval,
OpenClaw waits 750 milliseconds so the connecting Mac can submit its first
activity sample. It then tries the connected notification-capable Mac with the
freshest activity.

- If primary delivery succeeds, no other Mac receives the alert.
- If no active Mac is available or primary delivery fails, OpenClaw waits five
  seconds and tries every remaining connected Mac that exposes `system.notify`.
- Later reconnects are silent. The Gateway records the successful connection
  in pairing metadata, so a Gateway restart does not replay alerts for every
  previously connected node.

Alerts are bound to the authenticated node identity. A replacement session for
the same node takes over its pending first-connection alert; if that node is no
longer connected when delivery runs, the alert is canceled.

## Troubleshooting

| Symptom                                   | Check                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No row is marked `active`                 | Confirm a native macOS node is connected, then click or type in OpenClaw. For activity outside OpenClaw, enable system-wide detection and check `permissions.accessibility: true` in `openclaw nodes describe --node <id>`. |
| The wrong Mac remains active              | Interact with OpenClaw on the Mac you want to use, wait for the coalescing window, then rerun `openclaw nodes status`. With system-wide detection enabled, physical input in other apps also counts.                        |
| Last-input data disappears                | Check whether the Mac disconnected or its node session was replaced. Disabling system-wide detection or revoking Accessibility clears the system-wide sample; app-local activity can still select the Mac.                  |
| The alert appears on several Macs         | Primary delivery was unavailable or failed, so the delayed fallback ran. Verify that the active Mac is connected, allows notifications, and exposes `system.notify`.                                                        |
| The agent does not mention the active Mac | Start a new turn after activity changes. The runtime hint is stable and compact; use the `nodes` tool for exact current metadata.                                                                                           |

For TCC recovery, see [macOS permissions](/platforms/mac/permissions). For node
connection and command failures, see [Node troubleshooting](/nodes/troubleshooting).

## Related

- [Nodes](/nodes)
- [Nodes CLI](/cli/nodes)
- [System presence](/concepts/presence)
- [Gateway protocol](/gateway/protocol/presence#presence)
- [macOS app](/platforms/macos)
