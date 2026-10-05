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
typed layout and navigation surface, not screenshot capture or browser
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

Pass `expanded: true` with any panel show action to fill the conversation pane
with that view. For example:

```json
{ "action": "portal_show", "portalId": "<portal-id>", "expanded": true }
```

Pass `expanded: false` to restore the split view, or use the panel's restore
button. Expansion preserves the tabs, dock, and saved panel dimensions. It is
in-tab presentation, not browser fullscreen: the app navigation stays available,
and it does not start media playback or change autoplay permissions.

The desktop panel and computer tools address the same environment. `screen`
only presents it; computer tools perform clicks, typing, and screenshots.

An environment can appear before provisioning finishes. Desktop shows startup
progress and connects when that exact machine becomes available. `portal_show`
can take `environmentId` while its application is starting; replace it with the
application's `portalId` when ready. A pending Portal never opens another
application from the portal list.

A successful command returns `{ "ok": true }` after the Gateway sends
the typed `ui.command` event to the requesting browser.

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
