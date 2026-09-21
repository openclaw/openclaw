---
summary: "Watch or control a desktop-capable cloud worker from the Control UI"
title: "Cloud Worker Desktop"
read_when: "You want to observe or drive a cloud worker's desktop, or you are enabling the desktop lab."
---

Enabling the interactive desktop on a Crabbox profile, what Crabbox provisions for each operating system, and how the viewer reaches it without public ingress.

## Ask the agent to open an app

With a configured Crabbox profile, ask **"Open this in Crabbox and show me."**
The agent can attach a temporary environment to the current conversation, run
the application there, and open its view in the chat side panel. The agent's
primary workspace and session placement stay unchanged.

For open-and-show requests, the agent passes `presentation: "desktop"` or
`presentation: "portal"` when creating the attachment. The side panel opens
before allocation and shows machine startup progress. A web preview waits for
the requested application rather than displaying another portal. If the
requesting browser cannot receive the initial presentation, a fresh reservation
is canceled before provisioning; an existing attachment remains available.

For a native Linux app, use a profile with `settings.desktop: true` and enable
the **Cloud Worker Desktop** lab. The agent launches the application and opens
the Desktop panel. When its model supports vision and tool policy permits
`computer`, it can observe and control the same desktop using the attachment's
`environmentId`. Taking manual control pauses agent input; observations remain
available. Release manual control before asking the agent to interact again.

For a web app, the agent starts a server and opens a [portal](/gateway/portals)
in the side panel. A browser on the attached desktop can test that server with
CUA, but it has separate browser state and cookies from your portal view.

The Crabbox plugin's `crabbox` tool owns creation, status, remote commands,
background app processes, and stop. It is available only with a configured
Crabbox profile and outside sandboxed sessions. The existing `screen` tool
opens the Desktop or Portal panel in the browser that requested the turn.
Remote commands retain the conversation's `exec` and `process` tool policy and
use normal one-shot execution approval when configured. Executable allowlists
from the Gateway are not portable to the temporary machine: an allowlist policy
with approval disabled refuses remote commands rather than bypassing that policy.
Desktop viewers support Linux, macOS, and native Windows. Select a profile
target matching the application's operating system; WSL2 has no Crabbox desktop.

Follow-ups reuse the conversation's attached machine. Closing the side panel
hides its view; background apps remain available under the profile's lifetime.
Ask to stop a particular app or stop the entire Crabbox when finished. The
machine is disposable: save required outputs before stopping it. Attaching a
machine does not automatically synchronize the primary workspace; the agent
must copy the required files or prepare the project on the machine.

Stop attached machines before downgrading to a build without conversation
attachments. Older builds can read the database, but they treat these machines
as ordinary unassigned environments and do not maintain conversation activity
or cleanup. See [conversation environment storage](/reference/database-schemas/layout#conversation-environments)
for the backup, retention, and re-upgrade contract.

## Desktop (interactive)

Cloud Worker Desktop lets an administrator watch or control a capable worker from the Control UI without exposing its cloud node as an ordinary paired node. Enable the **Cloud Worker Desktop** lab, then set `settings.desktop: true` on a Crabbox profile. Linux, macOS, and native Windows use their own desktop setup, including when selected as a per-session OS override. Crabbox does not provide a desktop for Windows (WSL2); select native Windows for its desktop viewer. Desktop capability is fixed at warm time: changing the setting affects newly provisioned workers, while an existing non-desktop lease must be stopped and reprovisioned.

The lab switch applies without restarting the Gateway. Connected Control UI
pages update desktop availability automatically. Disabling it closes worker
desktop observations; the workers and their applications keep running.
Re-enabling it restores access to workers that already have desktop capability.
Changing the lab does not provision or replace workers.

The bundled Crabbox plugin supports direct AWS and Azure profiles. Coordinator-backed AWS, Azure, and Hetzner profiles are supported when the selected coordinator advertises Desktop and Browser capability. OpenClaw keeps worker execution node-only: `openclaw worker`, workspace transfer, desktop observation, and app launch all use the authenticated outbound node connection. It does not restore SSH execution, a reverse tunnel, or rsync. Direct Hetzner rejects OpenClaw's fixed lease ID, so desktop profiles fail before allocation unless Hetzner uses a capable managed coordinator.

On Linux, Crabbox provisions XFCE on display `:99`, an authenticated RFB server on `127.0.0.1:5900`, a fresh lease-scoped browser profile with CDP on `127.0.0.1:9222`, and fixed zero-argument Browser and Terminal launchers. The provider also installs an OpenClaw worker wallpaper so the disposable desktop is easy to identify. Setup is idempotent and completes before the cloud desktop becomes available, including on provisioning replay. Ordinary desktop workers finish this setup in the node enrollment command after launching the node. Project image preparation keeps desktop setup before project setup and capture.

On Linux, the enrolled node starts CUA inside that same XFCE session. A vision-capable agent whose tool policy permits `computer` controls this desktop through the session's exact placement; it cannot select another node. This works for both OpenClaw workers and Codex remote execution. See [Desktop and computer control](/gateway/cloud-sessions#desktop-and-computer-control) for tool enablement and manual-control guidance.

The desktop never gains public ingress. The node reads the platform-specific password file locally, inspects the loopback RFB security offer, and keeps that same connection for the viewer. It redeems a single-use Gateway broker ticket over the node's already-connected origin. Opening viewers therefore creates no extra unauthenticated probe connections. TLS deployments pin the same Gateway certificate used by the node connection. The Gateway revalidates the durable environment, lease, node, owner epoch, desktop descriptor, connection, and pairing both before dispatch and after attach; drain, replacement, or teardown aborts the stream and any pending app launch. The shared desktop session owner performs RFB preauthentication, view-only input filtering, and single-controller arbitration. Browser protocol negotiation overlaps worker authentication, but authentication success and desktop traffic wait for both sides to finish.

An open chat updates its desktop target when committed session placement events arrive, including worker replacement and teardown, without waiting for a sidebar refresh.

Closing the requesting Gateway connection cancels pending viewer setup and unclaimed node streams, freeing their observer slots without waiting for ticket expiry. Other connected viewers retain their streams.

If you close or replace a Desktop panel during setup, it releases the unused observation when setup returns. This frees that attempt's node stream and viewer slot without waiting for ticket expiry or interrupting another viewer. A connected viewer retains the existing brief-hide behavior.

The Gateway sends WebSocket keepalives on desktop observer and node desktop or portal streams while idle, so an unchanged screen or quiet preview does not go silent behind a proxy. Backpressure may delay pong replies without revoking the stream; the owning session and control connection still govern teardown.

When another operator takes control, your viewer reconnects in view-only mode. The notice identifies the new controller by their authenticated profile name, or their authenticated user ID when no profile name is set. Connections without an authenticated user identity show a generic takeover notice.

## Native desktops

macOS uses Crabbox's native Screen Sharing service. The provider reads the account name from the inspected lease and prepares a private password file readable by the enrolled node. The node sends the password through its authenticated outbound connection, and the Gateway performs Apple Remote Desktop account authentication before attaching the viewer. Account credentials never enter the browser.

Native Windows uses Crabbox's authenticated VNC service and its password file at `C:\ProgramData\crabbox\vnc.password`. Native workers skip Linux browser provisioning, XFCE setup, and Linux desktop environment discovery. The viewer supports observation and control; the Linux-specific Browser and Terminal launch buttons are not advertised for native desktops.

Warm-image reuse remains Linux only. Native desktops use cold provisioning even when the shared profile enables warm images. macOS also requires existing EC2 Mac Dedicated Host capacity in the selected provider region.

Before downgrading to a version without native desktop support, stop and release
all macOS and native Windows worker environments, including primary session
placements and conversation attachments. Wait for confirmed lease teardown;
closing the viewer or suspending a worker is not sufficient. Older Gateways can
reject persisted Windows password paths or discard the macOS account metadata
needed for authentication. Confirmed teardown clears the desktop descriptor so
those records can be read by the older version.

## Desktop size

Open **Systems** in the Control UI sidebar to select a worker and use its desktop
as the main workspace. The docked and chat-side Desktop panels remain available;
all presentations reuse the desktop connection implementation and Gateway control arbitration.

The **Desktop size** menu is available in the panel and the standalone desktop view:

- **Fit** is the default. It scales the existing framebuffer to the viewer without changing the worker's display resolution.
- **Actual** shows the framebuffer without local scaling or remote resizing.
- **Match** requests the viewer's dimensions as the worker's display resolution. It also scales locally while the request is pending or unsupported.

Match appears only after a controlling connection authenticates and the worker provider permits virtual-display resizing. View-only connections cannot request resizing. Direct host desktops do not gain this permission.

The Crabbox plugin permits requests for its dedicated Linux XFCE desktop. This permission does not prove server support. Match requires a VNC server that negotiates desktop resizing, such as Crabbox's dynamic TigerVNC desktop. Older fixed-size Xvfb/x11vnc workers remain usable with Fit and Actual. To resize those workers, update Crabbox to a build with dynamic XFCE support and reprovision the desktop worker. Changing the menu alone does not upgrade an existing worker.

A controlled reconnect to the same source retains the sizing choice. Changing sources resets it to Fit. Losing control or resize permission also resets Match to Fit.
