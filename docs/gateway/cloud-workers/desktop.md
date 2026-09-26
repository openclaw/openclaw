---
summary: "Watch or control a desktop-capable cloud worker from the Control UI"
title: "Cloud Worker Desktop"
read_when: "You want to observe or drive a cloud worker's desktop, or you are enabling the desktop lab."
---

Enable an interactive desktop on a Crabbox profile and connect through its authenticated cloud node.

## Ask the agent to open an app

With a configured Crabbox profile, ask **"Open this in Crabbox and show me."**
The agent can attach a temporary environment to the current conversation, run
the application there, and open its view in the chat side panel. The agent's
primary workspace and session placement stay unchanged.

Attached environments install and verify the worker bundle for remote app
commands, but skip prewarming the agent runtime because the agent stays on the
current execution host. OpenClaw worker turns still prewarm their agent runtime.

For open-and-show requests, the agent passes `presentation: "desktop"` or
`presentation: "portal"` when creating the attachment. The side panel opens
before allocation and shows machine startup progress. A web preview waits for
the requested application rather than displaying another portal. If the
requesting browser cannot receive the initial presentation, a fresh reservation
is canceled before provisioning; an existing attachment remains available.

For a native app, use a profile for its operating system with `settings.desktop: true`
and enable the **Cloud Worker Desktop** lab. The agent launches the application and opens
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
macOS and native Windows profiles require the image preparation described below.

Follow-ups reuse the conversation's attached machine. Closing the side panel
hides its view; background apps remain available under the profile's lifetime.
Ask to stop a particular app or stop the entire Crabbox when finished. The
machine is disposable: save required outputs before stopping it. Attaching a
machine does not automatically synchronize the primary workspace; the agent
must copy the required files or prepare the project on the machine.

If stopping a conversation environment fails, cleanup retries with exponential
backoff from 30 seconds to five minutes, on the next reconciliation sweep.
After ten attempts or one hour, whichever comes first, cleanup is parked for
the rest of that Gateway process. Environment status reports an error with the
lease ID, last failure, and recovery instructions; the lease stays owned and
blocks replacement until cleanup is confirmed. For Crabbox, inspect it with
`crabbox leases list` and run `crabbox stop <lease>` as needed, then retry Stop
in the conversation. An explicit Stop or Gateway restart starts a fresh retry
budget. A text-only 404 from Crabbox is an unknown cleanup outcome, not proof
that the lease was released.

Stop attached machines before downgrading to a build without conversation
attachments. Older builds can read the database, but they treat these machines
as ordinary unassigned environments and do not maintain conversation activity
or cleanup. See [conversation environment storage](/reference/database-schemas/layout#conversation-environments)
for the backup, retention, and re-upgrade contract.

## Desktop (interactive)

Cloud Worker Desktop lets an administrator watch or control a capable worker from the Control UI without exposing its cloud node as an ordinary paired node. Enable the **Cloud Worker Desktop** lab, then set `settings.desktop: true` on a Linux, prepared macOS, or native Windows Crabbox profile. Select `windows/normal` for Windows; WSL2 desktops are unsupported. Desktop capability is fixed at warm time: changing the setting affects newly provisioned workers, while an existing non-desktop lease must be stopped and reprovisioned. Warm-image capture remains Linux only. Native desktops provision cold even when the shared profile enables warm images.

The lab switch applies without restarting the Gateway. Connected Control UI
pages update desktop availability automatically. Disabling it closes worker
desktop observations; the workers and their applications keep running.
Re-enabling it restores access to workers that already have desktop capability.
Changing the lab does not provision or replace workers.

The bundled Crabbox plugin supports direct AWS and Azure profiles. Coordinator-backed AWS, Azure, and Hetzner profiles are supported when the selected coordinator supports that target's desktop. OpenClaw keeps worker execution node-only: `openclaw worker`, workspace transfer, desktop observation, and app launch all use the authenticated outbound node connection. It does not restore SSH execution, a reverse tunnel, or rsync. Direct Hetzner rejects OpenClaw's fixed lease ID, so desktop profiles fail before allocation unless Hetzner uses a capable managed coordinator.

Each node connects to its desktop's authenticated RFB server through `127.0.0.1:5900`. The desktop also has a browser with loopback CDP on port `9222` and provider-owned Browser and Terminal launchers. OpenClaw installs a worker wallpaper so the disposable desktop is easy to identify. Setup is idempotent and completes before the cloud desktop becomes available, including on provisioning replay. Project image preparation keeps desktop setup before project setup and capture.

Linux uses Crabbox's XFCE session on display `:99`. Native Windows uses Crabbox's interactive-session launcher so the enrolled node and CUA run as the desktop user, with the same account and session checked on replay. macOS uses the dedicated signed **OpenClaw Cloud Worker** app to host CUA and the enrolled node in the worker account's GUI session; see the image prerequisites below.

A vision-capable agent whose tool policy permits `computer` controls this desktop through the session's exact placement; it cannot select another node. This works for both OpenClaw workers and Codex remote execution. See [Desktop and computer control](/gateway/cloud-sessions#desktop-and-computer-control) for tool enablement and manual-control guidance.

The desktop never gains public ingress. The node reads the lease's password file locally, inspects the loopback RFB security offer, and keeps that same connection for the viewer. Linux and Windows use VNC password authentication. macOS uses Apple Remote Desktop account authentication with the inspected worker username and a private copy of Crabbox's managed password. These credentials pass transiently through the authenticated node connection for preauthentication; the viewer does not enter the worker password. The node redeems a single-use Gateway broker ticket over its already-connected origin. Opening viewers therefore creates no extra unauthenticated probe connections. TLS deployments pin the same Gateway certificate used by the node connection. The Gateway revalidates the durable environment, lease, node, owner epoch, desktop descriptor, connection, and pairing both before dispatch and after attach; drain, replacement, or teardown aborts the stream and any pending app launch. The shared desktop session owner performs RFB preauthentication, view-only input filtering, and single-controller arbitration. Browser protocol negotiation overlaps worker authentication, but authentication success and desktop traffic wait for both sides to finish.

An open chat updates its desktop target when committed session placement events arrive, including worker replacement and teardown, without waiting for a sidebar refresh.

Closing the requesting Gateway connection cancels pending viewer setup and unclaimed node streams, freeing their observer slots without waiting for ticket expiry. Other connected viewers retain their streams.

If you close or replace a Desktop panel during setup, it releases the unused observation when setup returns. This frees that attempt's node stream and viewer slot without waiting for ticket expiry or interrupting another viewer. A connected viewer retains the existing brief-hide behavior.

The Gateway sends WebSocket keepalives on desktop observer and node desktop or portal streams while idle, so an unchanged screen or quiet preview does not go silent behind a proxy. Backpressure may delay pong replies without revoking the stream; the owning session and control connection still govern teardown.

When another operator takes control, your viewer reconnects in view-only mode. The notice identifies the new controller by their authenticated profile name, or their authenticated user ID when no profile name is set. Connections without an authenticated user identity show a generic takeover notice.

Before downgrading to a Gateway that cannot read the desktop metadata in use,
stop and release the affected worker environments, including primary session
placements and conversation attachments. This includes native desktops when the
older Gateway lacks their metadata, and any provider using fixed launcher `args`
in browser or terminal descriptors. Launcher arguments can also be used by Linux
providers; support for native desktop viewing alone does not make an older
Gateway compatible with those records.

Wait for confirmed lease teardown; closing the viewer or suspending a worker is
not sufficient. Older Gateways can reject unsupported password paths or launcher
arguments, or lack the macOS account metadata needed for authentication.
Confirmed teardown clears the desktop descriptor so those records can be read
by the older version. If you already downgraded, return to a supporting release
to stop those workers first.

<a id="native-desktops" />

## macOS image prerequisites

Prepare a macOS 15 or later worker image with `/Applications/OpenClawCloudWorker.app`, signed with a Developer ID Application identity and containing its bundled CUA driver. Build the dedicated app from a source checkout on macOS:

```bash
OPENCLAW_MAC_CLOUD_WORKER_HOST=1 scripts/package-mac-app.sh
```

Install the resulting `dist/OpenClawCloudWorker.app` in the image. Grant **OpenClaw Cloud Worker** Accessibility and Screen Recording access for the intended worker account, install Google Chrome, and sign in to an unlocked desktop. The cloud app has its own bundle identity and permission grants, separate from the ordinary OpenClaw app. Provisioning verifies the signed cloud-host capability before starting it; an older or ordinary app does not satisfy this requirement.

The app uses the existing [local CUA trust boundary](/nodes/computer-use#trust-model): processes running as the worker account can discover and use its desktop resources. Desktop profile and tool-policy settings govern managed OpenClaw entry points; they do not sandbox authorized shell code. Use a separate account or image without these desktop grants when isolation from that code is required.

Keep Crabbox's passwordless `sudo` access enabled for the worker account. Desktop launch uses it to enter the GUI session, then runs the app, browser, and terminal as that worker account.

The app owns both CUA and the ephemeral cloud node. While its GUI session remains unlocked, it renews a short-lived idle assertion to keep the desktop active between turns. An explicit or managed lock still ends the cloud host. The app releases the assertion and stops the node before retiring CUA if its desktop session or daemon becomes unavailable. Reprovision an unavailable desktop after restoring the image prerequisites. Existing cloud placement, enrollment, and teardown owners continue to govern the lease.

AWS macOS requires an available EC2 Mac Dedicated Host and On-Demand allocation. Configure the prepared image and host selection through Crabbox on the Gateway host. Crabbox does not allocate a new Dedicated Host implicitly. See [Crabbox provider support](/gateway/cloud-workers#coordinator-backed-crabbox).

## Native Windows prerequisites

Use a managed Windows desktop image with Crabbox's **CrabboxDesktopLauncher** service and an active desktop for the configured worker account. Desktop enrollment runs inside that interactive session; the ordinary detached SSH launcher remains the path for headless Windows workers. A Session 0 process or a process belonging to another account cannot satisfy desktop enrollment replay. See [Windows runtime prerequisites](/gateway/cloud-workers/setup-and-bundle-installation#native-windows-prerequisites).

OpenClaw switches the lease's managed TightVNC server to the interactive account with GDI capture, preserving Crabbox's VNC authentication and restricting the listener to loopback. The image must permit TightVNC application mode. Provisioning replay reuses the verified server so attached viewers stay connected; release and reprovision the worker after its interactive session ends.

This mode controls the active desktop; it does not provide sign-in, Ctrl+Alt+Delete, or secure-desktop control. Use OpenClaw provisioning replay or reprovisioning for recovery. Crabbox's generic VNC reset manages service mode.

Workspaces containing symbolic links require Windows Developer Mode in the image or the **Create symbolic links** privilege for the interactive account.

## Desktop size

Open **Systems** in the Control UI sidebar to select a worker and use its desktop
as the main workspace. The docked and chat-side Desktop panels remain available;
all presentations reuse the desktop connection implementation and Gateway control arbitration.

The **Desktop size** menu is available in the panel and the standalone desktop view:

- **Fit** is the default. It scales the existing framebuffer to the viewer without changing the worker's display resolution.
- **Actual** shows the framebuffer without local scaling or remote resizing.
- **Match** requests the viewer's dimensions as the worker's display resolution. It also scales locally while the request is pending or unsupported.

Match appears only after a controlling connection authenticates and the worker provider permits virtual-display resizing. View-only connections cannot request resizing. Direct host desktops do not gain this permission.

The Crabbox plugin permits resize requests for its dedicated Linux XFCE desktop. Match also requires a VNC server that negotiates desktop resizing, such as Crabbox's dynamic TigerVNC desktop. Native worker desktops and older fixed-size Xvfb/x11vnc workers use Fit and Actual. To resize older Linux workers, update Crabbox to a build with dynamic XFCE support and reprovision the desktop worker. Changing the menu alone does not upgrade an existing worker.

A controlled reconnect to the same source retains the sizing choice. Changing sources resets it to Fit. Losing control or resize permission also resets Match to Fit.
