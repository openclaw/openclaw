---
summary: "Let an agent arrange the connected Control UI"
title: "Screen"
sidebarTitle: "Screen"
read_when:
  - You want an agent to split, focus, close, or navigate Control UI panes
  - You want an agent to show or hide the sidebar, terminal, or browser panels
  - You need the ui.command capability and requester routing contract
---

The `screen` tool lets an agent arrange the browser-based Control UI. It is a
typed layout, navigation, and visual guidance surface, not screenshot capture or browser
automation.

The tool is exposed only when the originating client advertises the
`ui-commands` capability. The selected person's requesting Control UI must still be
connected when the tool runs; otherwise the Gateway returns `UNAVAILABLE`.

A client advertises `ui-commands` in the `caps` array it sends during the
Gateway connect handshake (see
[Gateway protocol](/gateway/protocol/rpc-methods#rpc-method-families)). The
bundled Control UI advertises it already, so there is nothing to turn on there.
A client that does not advertise it is never offered `screen`, so the tool is
absent rather than failing at call time.

## Actions

| Action                            | Effect                                     | Optional inputs                                         |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `split_right`                     | Split the target session pane to the right | `sessionKey` (defaults to the current session)          |
| `split_down`                      | Split the target session pane downward     | `sessionKey` (defaults to the current session)          |
| `close_pane`                      | Close the target session pane              | `sessionKey` (defaults to the current session)          |
| `focus`                           | Focus the target session pane              | `sessionKey` (defaults to the current session)          |
| `navigate`                        | Open the target session                    | `sessionKey` (defaults to the current session)          |
| `sidebar_show` / `sidebar_hide`   | Show or hide the main sidebar              | -                                                       |
| `terminal_show` / `terminal_hide` | Show or hide the operator terminal panel   | `dock` (`bottom` or `right`) when showing               |
| `browser_show` / `browser_hide`   | Show or hide the browser panel             | `dock` (`bottom` or `right`) when showing               |
| `desktop_show` / `desktop_hide`   | Show or hide a remote desktop              | `environmentId`, `sessionKey`, `dock` (default `right`) |
| `portal_show` / `portal_hide`     | Show or hide a web application portal      | `portalId`, `sessionKey`, `dock` (default `right`)      |

Every action accepts optional `user`, the person's verified `requester_profile.id`
from the Control UI message's conversation context. When several people have
steered the turn, `user` is required; the agent chooses the person who asked or
asks them if it is unclear.

For a native application running on an attached environment, use `desktop_show`
with its `environmentId`. For a web application, open a portal for the server's
port, then use `portal_show` with the returned `portalId`. The selected view opens
in that conversation's side panel. Hiding a view does not stop its application,
close the portal, or release the environment.

The desktop panel and computer tools address the same environment. `screen`
only presents it; computer tools perform clicks, typing, and screenshots.

An environment can appear before provisioning finishes. Desktop shows startup
progress and connects when that exact machine becomes available. `portal_show`
can take `environmentId` while its application is starting; replace it with the
application's `portalId` when ready. A pending Portal never opens another
application from the portal list.

A successful command returns `{ "ok": true }` after the Gateway sends
the typed `ui.command` event to the requesting browser.

## Visual guidance

Use `annotate` when someone asks where a control is or how to complete a task.
It points; the person still clicks. An annotation never types, navigates, opens a
panel, or moves keyboard focus. Calls replace the previous guide in that browser.

```json
{
  "action": "annotate",
  "annotations": [
    { "target": { "control": "side-panel" }, "text": "Start here. Open your side panel." }
  ]
}
```

After the person opens an empty side panel, point at `terminal-new`. If the
panel already contains tabs, point at `panel-new` first, then `terminal-new`
in that menu. Do not treat delivery as evidence that the person clicked.

Each call accepts 1–4 annotations, each with:

- `target`: exactly one of `{ control }`, `{ sessionKey }`, or `{ text }`.
- `text`: a plain-text label, 1–200 characters. No HTML or Markdown execution.
- `style`: `arrow` (default), `outline`, or `note` (a label with a connector).
- `color`: `coral` (default), `teal`, or `purple`.

Known controls are `side-panel`, `panel-new`, `terminal-new`, `settings`,
`agent-menu`, `agent-new`, and `session-new`. A session target matches its
visible sidebar row, including pinned rows. Text matches exact normalized visible
copy or an accessible label. Targets do not search unloaded history, hidden menus,
other browser tabs, native desktop windows, or content inside embedded frames.
The target must be unique and visible; otherwise a waiting label appears without
an arrow. Reveal it before the guide expires to resolve it. No coordinates or
arbitrary selectors are accepted.

```json
{
  "action": "annotate",
  "annotations": [
    {
      "target": { "sessionKey": "agent:main:website-launch" },
      "text": "Your launch conversation is pinned here.",
      "style": "outline",
      "color": "teal"
    }
  ],
  "durationSeconds": 45
}
```

Guides expire after 30 seconds by default (`durationSeconds`: 3–120). Escape,
**Dismiss guide**, a click on a target, changing conversations, leaving the tab,
or disconnecting clears them. `{ "action": "annotations_clear" }` clears them
explicitly. Guides are never persisted in history or replayed after reconnect.
They follow scrolling and resizing without animation, including reduced-motion
settings. Their arrows and labels let clicks through; only Dismiss is interactive.
When the labels cannot fit without overlapping, a scrollable compact list replaces
the arrows so every instruction stays reachable.

Annotation commands return `{ "ok": true, "status": "dispatched" }`. This is a
**delivery acknowledgment, not a rendered-target or user-action acknowledgment**.
The browser owns target resolution; this draft does not return a DOM inventory
or target-resolution receipt to the agent. Keep verbal guidance alongside the
visual hint, and ask the person what they see when the target is unavailable.

## Routing and security

Commands change only the selected person's requesting Control UI connection. Other
people's dashboards and your other tabs keep their current view. `sessionKey`
chooses which session to open; it does not choose the recipient.

The Gateway captures the browser target when it accepts the message and keeps
it with queued turns and worker execution. If that browser disconnects or the
turn has no Control UI target, the command fails with `UNAVAILABLE`. Ask again
from the open Control UI; the command never falls back to a broadcast.

People with matching permissions can steer the same turn. Each participant
keeps their own captured browser target; `user` can select only the turn's owner
or an accepted participant. A queued or rejected steer does not add a participant.
If the selected person's access has changed, they must ask again.

Standalone RPC and MCP callers that previously used `ui.command` to broadcast
must invoke it from a requesting Control UI connection or an agent turn started
there. Without that browser target, they now receive `UNAVAILABLE`, even if
other dashboards are connected. This intentionally replaces the legacy
broadcast contract.

The Gateway RPC requires `operator.write`. The tool can change presentation
state only: it cannot read pixels, take screenshots, click arbitrary page
content, or bypass the permissions of the selected session and operator
panels.

## Related

- [Control UI](/web/control-ui)
- [Gateway protocol](/gateway/protocol/rpc-methods#rpc-method-families)
- [Browser tool](/tools/browser)
