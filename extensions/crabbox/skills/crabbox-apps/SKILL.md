---
name: crabbox-apps
description: Use when asked to open, run, test, or show an app in Crabbox, including native desktops, web previews, and computer use on a temporary machine.
user-invocable: false
---

# Apps in Crabbox

"Open in Crabbox and show me" means launch the working application and open its
view in the requesting user's chat side panel. Finish both operations.

Use the enabled `crabbox` tool to inspect the current attachment before creating
one. Reuse that environment for follow-ups. `profiles` discovers configured
profiles; choose one compatible with the application. Native desktop viewing
and CUA require a desktop-enabled profile. Never silently substitute another OS
for an application that requires a particular platform.

`create` attaches the machine to this conversation without moving the agent or
its primary workspace. For an open-and-show request with the `screen` capability
available, pass `presentation: "desktop"` for a native app or
`presentation: "portal"` for a web app. This opens the right sidebar with machine
startup progress before provisioning finishes. Its result identifies the
environment. Use `exec` for commands on that environment; the ordinary shell still has its existing target.
Copy or recreate the task's required files explicitly. Do not assume the local
project was synchronized.

## Native apps

1. Install or build the app using remote `exec` as needed.
2. Launch it with `exec` and `background: true`. Retain its `processId` for
   status, logs, and stop. Do not detach a shell process to escape lifecycle ownership.
3. When the `computer` tool is available, select the returned `environmentId`
   and observe the application. CUA operates on the same desktop shown by VNC.
4. When the `screen` tool is available, call `desktop_show` with that
   `environmentId` and `dock: "right"`. Verify the app is ready before claiming
   success. An allocated machine or a blank desktop alone is insufficient.

## Web apps

1. When the `portal` tool is available, open a portal for the environment and
   application's port using `environmentId`. Keep its portal ID and public URL.
2. Start the web server with remote `exec`, `background: true`, and the
   application's `PORT` and `PUBLIC_URL` set explicitly. Verify it responds.
3. When the `screen` tool is available, use `portal_show` with the returned
   `portalId` and `dock: "right"`. Show the web application directly in the portal.
4. For CUA testing, use the attached environment's browser against the same
   server. The remote browser and the user's portal have separate cookies and
   browser state; do not assume they share a login or page navigation.

If an essential tool or desktop capability is unavailable, report the missing
capability and the actual completed state. A portal that the user's browser
cannot reach is not a completed preview. Preserve the separate-origin portal
transport; never expose arbitrary application scripts on the Gateway origin.

## Follow-ups and cleanup

Reopen the current environment or portal for "show me again". A viewer reconnect
must not allocate another machine. Before showing a remembered portal, confirm
it still exists with `portal list`; portal IDs can expire across Gateway restarts.
If it is gone, open a replacement for the same environment and running app port,
then show and verify that new portal. Refresh the app's `PUBLIC_URL` if it relies
on that URL for links or redirects. Use `process_status` to inspect a launched
app and `process_stop` to stop just that process. `stop` releases the entire
temporary environment. Closing the side panel only hides the view.

Observe again before CUA input. When the user takes desktop control, stop sending
input until they release control; screenshot reads may continue. Never work
around a control-ownership refusal with shell-injected clicks.

The machine is disposable and follows its configured lifetime. Preserve requested
outputs before stopping it; the conversation transcript alone is not a backup
of remote files.
