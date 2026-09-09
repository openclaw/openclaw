---
summary: "Watch or control a desktop-capable cloud worker from the Control UI"
title: "Cloud Worker Desktop"
read_when: "You want to observe or drive a cloud worker's desktop, or you are enabling the desktop lab."
---

Enabling the interactive desktop on a Linux Crabbox profile, what Crabbox provisions for it, and how the viewer reaches it without public ingress.

## Desktop (interactive)

Cloud Worker Desktop lets an administrator watch or control a capable worker from the Control UI without exposing its cloud node as an ordinary paired node. Enable the **Cloud Worker Desktop** lab, then set `settings.desktop: true` on a Linux Crabbox profile. Desktop setup is Linux only. Desktop capability is fixed at warm time: changing the setting affects newly provisioned workers, while an existing non-desktop lease must be stopped and reprovisioned.

The bundled Crabbox plugin supports direct AWS and Azure profiles. Coordinator-backed AWS, Azure, and Hetzner profiles are supported when the selected coordinator advertises Desktop and Browser capability. OpenClaw keeps worker execution node-only: `openclaw worker`, workspace transfer, desktop observation, and app launch all use the authenticated outbound node connection. It does not restore SSH execution, a reverse tunnel, or rsync. Direct Hetzner rejects OpenClaw's fixed lease ID, so desktop profiles fail before allocation unless Hetzner uses a capable managed coordinator.

Crabbox provisions XFCE on display `:99`, an authenticated RFB server on `127.0.0.1:5900`, a fresh lease-scoped browser profile with CDP on `127.0.0.1:9222`, and fixed zero-argument Browser and Terminal launchers. The provider also installs an OpenClaw worker wallpaper so the disposable desktop is easy to identify. Setup is idempotent and runs before node enrollment on every provisioning replay.

The enrolled node starts CUA inside that same XFCE session. A vision-capable agent whose tool policy permits `computer` controls this desktop through the session's exact placement; it cannot select another node. This works for both OpenClaw workers and Codex remote execution. See [Desktop and computer control](/gateway/cloud-sessions#desktop-and-computer-control) for tool enablement and manual-control guidance.

The desktop never gains public ingress. The node reads `/var/lib/crabbox/vnc.password` locally, inspects the loopback RFB security offer, and keeps that same connection for the viewer. It redeems a single-use Gateway broker ticket over the node's already-connected origin. Opening viewers therefore creates no extra unauthenticated probe connections. TLS deployments pin the same Gateway certificate used by the node connection. The Gateway revalidates the durable environment, lease, node, owner epoch, desktop descriptor, connection, and pairing both before dispatch and after attach; drain, replacement, or teardown aborts the stream and any pending app launch. The shared desktop session owner performs RFB preauthentication, view-only input filtering, and single-controller arbitration.

The Gateway sends WebSocket keepalives on desktop observer and node desktop or portal streams while idle, so an unchanged screen or quiet preview does not go silent behind a proxy. Backpressure may delay pong replies without revoking the stream; the owning session and control connection still govern teardown.
