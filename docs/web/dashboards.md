---
summary: "Session dashboards: agent-built widgets, boards, tabs, and flexible task layouts"
read_when:
  - Using or explaining session dashboards in the Control UI
  - Deciding what agents can do on a board and what needs an operator grant
title: "Session Dashboards"
---

Every thread in the Control UI can own a **dashboard** — a grid of live widgets
your agent builds for you. Choose **Dashboard** in the side panel to open the
current task's board, even before it has widgets. This leaves your chat draft
unchanged. When its first widget is pinned, the dashboard opens beside the
conversation in a resizable side panel, unless you have already chosen a layout
for that task. Use the task toolbar's **Swap** button to exchange the dashboard and
chat, or its **Layout** menu to move the side panel left, right, or below the
main area. Later widget updates leave your current panel layout unchanged.
Closing and reopening the panel does not restart loaded widgets or discard their
unsaved input. Reloading the page starts fresh widget views.

There is nothing to set up and no separate app to configure: dashboards are a
core feature, owned by the thread, stored with the agent, and they survive
`/new` and `/reset` (the conversation context clears; the board stays).

## Find your dashboards

Open `/dashboards` to browse dashboard-enabled threads as a card gallery. Search
by thread or author, filter by author, and sort by recent activity or title.
Stored sessions without a matching task URL remain visible as previews without an open link.
Select a linked card to open its owning task using your personal presentation override
or the dashboard’s shared default. Ordinary card clicks stay in the app and preserve
retained widget interactions. In fullscreen, choose **Restore split** to
bring the side panel alongside it. An open Dashboards page updates as threads
are renamed, archived, or deleted, including
after a Gateway reconnect.
If a refresh fails, the page keeps the last loaded dashboards visible with a
stale-data warning. Choose **Retry** to load the list again.

The dashboard and its shared presentation default follow you when you connect
to the same Gateway from another device. Personal presentation overrides, the
active dashboard tab, and other task layout choices remain per-device UI state. The browser retains layout and tab preferences
for up to 500 sessions, keeping the most recently changed entries when it reaches
that limit. Ordinary task revisits restore the browser's saved arrangement for
that task; gallery cards follow the same presentation preference. Increasing the
limit does not recover preferences already evicted by an older version.

The browser keeps the three most recently visited tasks in each pane loaded,
including their dashboard widgets, while you switch tasks or visit Settings.
Returning to a retained task preserves widget interactions and reading position;
changed content refreshes in place. Older tasks may reload when reopened. A browser
reload or a change of Gateway or signed-in user clears these retained views.

## Arrange your task

The main area and side panel can show either the dashboard or chat. Browser,
Terminal, Files, and Review use the same layout controls:

- **Swap** in the task toolbar exchanges the main view and active side-panel
  tab. Its tooltip names both views, for example **Swap Chat and Dashboard**.
  The previous main view becomes the active side-panel tab; other tabs stay
  available.
- **Layout** in the task toolbar moves the side panel left, right, or below the
  main area. Drag the divider to resize it. Narrow panes use a bottom panel
  until there is room for a side-by-side layout again.
- Click the **Dashboard** side-panel tab to expand the dashboard to the full
  task area in one step, even when another tab is selected. Click it again to
  restore the split. Arrow-key tab navigation only selects the tab; Enter or
  Space expands or restores Dashboard. Other tabs keep their normal selection
  behavior.
- **Expand** beside the side panel’s close **×** expands its active tab. The
  same control becomes **Restore split** and stays beside **×** while expanded.
  Restoring returns the original main view, panel placement, and size without
  swapping chat and dashboard. Closing the expanded panel returns to the main
  view instead.
- **Focus** in the task toolbar gives the main view the full task area.
  **Restore split** brings back the side panel with its previous placement and
  size.

Swapping, moving, and focusing preserve the live views, including chat drafts
and widget interactions. Closing the whole side panel hides its tabs and leaves
the main view in place. Closing the Dashboard tab removes that view from the
layout; it does not delete the board. Reopen it from the panel's **+** menu.
An empty dashboard stays open so you can add its first widget without changing
your chosen layout. The task toolbar sits above the main pane, aligned with the
side-panel tabs when the panes are side by side. In a stacked layout, each
header stays above its own pane. Side-panel tabs appear only when there are
views to switch between.

## Build a dashboard by asking

For a pinned data summary, ask for a **native report** with text, metrics, tables,
charts, or links. Reports render directly on the dashboard without an iframe or
inline preview. The agent updates the report's data when you ask; use an HTML
widget when you need custom interactivity. See [Native dashboard reports](/tools/show-widget#native-dashboard-reports).

Watch Patrick Erichsen build an OpenClaw 2.0 release dashboard from one prompt:

<iframe
  style={{ width: "100%", height: "auto", aspectRatio: "16 / 9", border: 0, borderRadius: "8px" }}
  src="https://www.youtube-nocookie.com/embed/gHyBueWideg"
  title="Build an OpenClaw Dashboard with One Prompt"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  referrerPolicy="strict-origin-when-cross-origin"
  allowFullScreen
></iframe>

Ask your agent for what you want to see:

> Create a widget named revenue-graph: an interactive bar chart of monthly
> revenue. Add "Bars" and "Trend" buttons that switch views. Pin it to my
> dashboard.

For this interactive HTML widget, the agent renders an inline chat preview first.
From there:

- **You pin it**: hover an inline widget and choose **Pin to dashboard**.
- **Or the agent pins it** directly when you ask, and updates it later by
  name — widgets have stable names, so "update revenue-graph with June's
  numbers" replaces the content in place while the board stays put.

The first dashboard created for an unarranged thread opens in the side panel once.
Updates after that do not reopen the panel or take focus from your current work.

Widgets are self-contained little apps (HTML/JS/SVG in a hard sandbox). Buttons
and view toggles inside a widget work immediately — switching a chart view
never needs the agent.

## The board

- **Fluid grid.** Drag widgets by their handle; everything reflows and
  compacts automatically. Resize by handle or pick a size preset (small,
  medium, large, extra large) from the widget menu. Nobody places pixels —
  not you, not the agent. On narrow boards, widgets stack at full width in
  their saved order; widening the board restores their saved column widths.
- **Automatic height.** HTML widgets adjust their height to fit their content.
  Resizing by handle or choosing a size preset fixes the height. Choose
  **Auto height** from the widget menu to fit the content again.
- **Tabs.** A board can have several pages — say, an overview tab and a
  focused tab with one big widget. Each tab remembers its widget layout.
  Visited tabs stay loaded while the dashboard is retained, preserving local
  filters and widget interactions when you switch back. Unvisited tabs load on
  demand; changed content still refreshes, and removed tabs release their widgets.
  Moving a loaded widget to another tab also preserves its unsaved input and interactions.
- **Dashboard view.** The board can occupy the main area or a resizable side
  panel. With Dashboard active in the side panel, choose **Swap** in the task
  toolbar, then **Focus** for a dashboard-only view. **Restore split** brings
  the side panel back. A tab with one full-width widget fills the focused
  dashboard, using all available width and height without a card border.
  Standard HTML widgets keep their content padding when maximized; widgets
  explicitly set to full-bleed or frameless remain edge to edge.
  Embedded MCP apps follow the available space
  when you resize the window or restore the split.
  Its widget controls move into the task toolbar’s **…** menu, leaving no
  hover pill or drag and resize handles over the page. Granted permissions
  remain available in that menu; approval requests and errors stay visible
  in the widget.
  Restoring the split or adding another widget brings back the normal spacing.
- **Shared default.** In the task menu’s **Layout** submenu, choose **Use current
  view as default** to make ordinary session opens, including sidebar links, show
  Dashboard in its current fullscreen or split view.
  While Dashboard is shown, **This is the default view** confirms that the current
  fullscreen or split view and the session's opening view both match the shared
  default, including for read-only viewers. When the view differs, **Use current view as default** is available
  if you can edit the session. Both explain that personal layout choices still
  apply. Merely opening, swapping, or focusing a panel does not change the shared
  default. If an older dashboard saved its fullscreen or split presentation but
  still opens as Chat, choose **Use current view as default** once to save both
  choices together. Saving does not rearrange
  anyone already viewing the dashboard; the default applies on subsequent opens
  and revisits, including opens from the dashboard gallery.
  Your browser’s deliberate **Focus** / **Restore split** choice takes precedence
  over the shared default. Choosing the shared view again clears that personal
  override. Applying a shared default does not create a personal override.
  Dock position, dimensions, and other panels remain local. Reopening or reloading
  an unchanged dashboard view preserves the selected side-panel tab, including
  Side chat or Files when Chat remains main. It also preserves a closed side panel
  or a focused Chat view. Existing browser layouts without presentation provenance retain
  their complete saved layout
  until you deliberately choose a presentation; OpenClaw does not guess whether
  an older expansion was automatic. Local layout retention remains 500 sessions.
  An explicit `?dashboard=expanded` link requests fullscreen for that visit only.
- **Agent parity.** The agent's `dashboard` tool creates or updates trusted
  plugin widgets, moves, resizes, and removes widgets, manages tabs, switches
  the visible tab, and requests a split or expanded dashboard with
  `set_presentation` and `presentation: "split"` or `"expanded"`. The `show_widget` tool
  creates or refreshes native reports, custom HTML, and registered-source widgets.
  An update uses `pin: true`, the same `name`, and new `widget_code` for HTML or
  registered source, or a new `report` object for a native report.
  Board snapshots identify each widget's `contentOwner` and, when applicable,
  `registeredContentKind`; remove a widget before replacing its content owner
  or registered source kind.
  Ask "show the finance tab and expand the dashboard" and watch it happen.

  To publish the initial view instead, use `dashboard` with
  `action: "set_default_presentation"` and `presentation: "split"` or `"expanded"`.
  This durable operation works without a connected browser. `action: "read"`
  returns the effective `defaultPresentation`, which is `"split"` when unset.
  Both the menu and agent use the same authorized `sessions.patch` mutation to
  save `boardFace: "dashboard"` and `boardPresentation` together.
  The optional `boardPresentation` metadata is stored with the session, survives
  restart and `/new` or `/reset` of that session, and is removed with session
  deletion. Patching `boardPresentation: null` restores the built-in split default.
  No database schema migration or backfill is required. Older builds ignore this
  presentation behavior; reverting does not remove boards or transcripts.

  Switching the visible tab or dashboard presentation requires a connected
  Control UI. If none is connected, the command returns `UNAVAILABLE`; open the
  Control UI and retry.
  `focus_tab` shows the dashboard in its current position. Call
  `set_presentation` after focusing the tab: `presentation: "expanded"` makes
  the dashboard main and focuses it; `"split"` reveals it using the current
  arrangement, bringing chat alongside when Dashboard is main.

## Show a website fullscreen

Ask your agent:

> Put <https://status.example.com> on this dashboard, expand it to fill the task,
> and pin this session in the sidebar as Status.

The built-in **Website** widget loads the live site directly in your browser.
It needs no plugin, relay server, or copied website code. A single full-width
website fills the expanded dashboard; adding other widgets restores the normal
grid. The website controls its own refreshes and navigation.

The agent creates it with the existing `dashboard` tool:

```json
{
  "action": "widget_put",
  "name": "status",
  "title": "Status",
  "pluginKind": "session:website",
  "props": { "url": "https://status.example.com" },
  "size": "full"
}
```

It then calls `dashboard` with `action: "set_presentation"` and
`presentation: "expanded"`. Session naming and pinning use the existing
`sessions` tool. Reuse the widget name to change its URL. The URL and layout
persist with the board; expanded presentation follows the existing per-device
task layout preference. Website widgets do not load in gallery thumbnails.

URLs must use HTTPS, contain no username or password, and fit within 2048
characters. The renderer refuses the Control UI and connected Gateway hostnames,
including URLs using another port on those hosts.
The frame supports the website's scripts, forms, storage, and links, but receives
no injected Gateway tokens, widget tool bridge, or permission to navigate the parent
app. It follows the website's own authentication and your browser's cookie policy.

Some websites refuse embedding, and some sign-in flows require a separate tab.
Use **Open website** if the frame stays blank or cannot sign in. OpenClaw does
not proxy the site or remove its embedding restrictions. This widget is separate
from custom HTML widgets and does not loosen their sandbox or network grants.

## Share a browser dashboard with your agent

Ask for a **Browser dashboard** when you want a saved dashboard where your agent
can read and interact with the same page you see:

> Open this HTTP status app as a fullscreen dashboard. Pin this session as
> Service Status, and use that same page when I ask you to change its filters.

To show the browser beside chat, ask to open the
[Browser side panel](/web/control-ui/panels#browser-panel). That opens the
existing panel without creating a dashboard widget or expanding the board.

The Browser plugin's `browser:dashboard` widget presents a tab in a local
OpenClaw-managed browser. The Control UI streams that tab, so HTTP apps also
work when the Control UI itself uses HTTPS. The browser's existing navigation
policy still applies. It does not inherit the browser cookies on your phone or
laptop. Administrators use the managed profile's login session. Other session
writers use an isolated context with its own cookies and storage.

The agent creates the widget through `dashboard`:

```json
{
  "action": "widget_put",
  "name": "service-status",
  "title": "Service Status",
  "pluginKind": "browser:dashboard",
  "props": { "url": "http://status.example.com" },
  "size": "full"
}
```

It then uses the existing `browser` tool with the widget name:

```json
{ "action": "snapshot", "dashboard": "service-status", "refs": "aria" }
```

`act` and `navigate` accept the same `dashboard` selector. The selector resolves
the current tab, so the agent does not need to reopen the URL or guess a target
ID. Use `dashboard` to arrange the board, expand it with `set_presentation`, and
remove widgets; session naming and pinning use `sessions`. No separate
site-specific tool is needed.

For administrators, hiding the dashboard or resetting its conversation keeps its browser tab.
Ordinary tab closing and idle cleanup do not close a tab owned by a dashboard.
Use **Stop browser** to release a running tab and **Resume browser** to open it
again. Agent equivalents are `browser` with `action: "close"` or `"open"` and
the `dashboard` selector. Stop also persists before the first open, without
starting a browser; reopening the dashboard or restarting the Gateway keeps it
paused until Resume. Resuming loads the saved URL; unsaved document state
does not survive closing the browser. If closure is temporarily unavailable,
the dashboard shows that Stop is pending and offers **Retry stop** until closure
is confirmed. Removing or replacing the widget releases
its old tab when Browser receives the board change; the existing cleanup cycle
also reconciles missed changes. Gallery previews never start a browser.

Administrator browser dashboards require Browser access and use the `openclaw` managed profile
by default. Optional `props.profile` selects another local managed profile;
attached personal browsers, node routing, and remote browser profiles are not
supported for this widget. The lightweight **Website** widget remains useful
when you only need to display an embeddable HTTPS website in your own browser.

### Session writer access

With the Browser plugin enabled, a non-admin session writer can open a Browser
dashboard without `operator.admin`. `operator.write` retains the session's
existing collaborator rules. The narrower `operator.sessions.write` grants
access only to the caller's own sessions. Effective browser tool policy still
applies; this feature does not change role or tool defaults.

The **Session browser** mode uses the configured default local managed profile
to launch an empty, isolated browser context for that session and widget.
Custom, attached, personal, extension, node and remote profiles are unsupported.
Cookies and storage are separate from administrator browsers and other sessions.
The agent's `dashboard` selector uses this same context when acting for a
non-admin operator. Administrator views and selectors continue to use their
separate managed-profile tab; their page state is not shared with Session browser.

Session browser supports page navigation, inspection, screenshots and interaction.
It does not expose profile management, arbitrary tab selection, file transfers,
or cookie/storage administration. The general browser tool keeps its existing
configured host/profile access: this isolation applies to the dashboard route
and selector, not to the whole agent.

The context survives a normal turn ending or a viewer disconnecting. Revoking a
person's access stops their viewer and operations without destroying the context
for other authorized collaborators. Resetting or deleting the session, removing
the widget, retiring the browser profile, or restarting the Gateway closes the
context. Session browser's Stop state is in memory; Resume starts from the saved
widget URL. The Gateway retains at most 64 isolated dashboard records; remove an
unused browser widget if that limit is reached.

Sessions that require a sandbox or have locked model selection cannot use this
mode. An isolated Gateway browser context is not a sandbox backend. The existing
administrator browser path remains available under its existing rules.

## What widgets are allowed to do

Custom HTML and registered-source widgets that only render need no approval —
they appear instantly, exactly like inline chat widgets, and their network access
is fully disabled.

Widgets that want **reach** must declare it. An explicit [session permission mode](/gateway/permission-modes)
decides what happens: **Full access** grants immediately; **Workspace** uses an
AI reviewer and rejects anything it does not allow; **Guarded** shows an
**Allow** / **Reject** card; **Read only** rejects the request. Without an
explicit session mode, the equivalent configured exec approval policy applies.

- **Network** (`net`): fetch declared HTTPS origins directly from the sandbox —
  a weather card that refreshes itself from an API, for example.
- **Gateway data** (`data`): read-only feeds like sessions, usage, or cron
  status, resolved by the gateway — the widget never holds your token.
- **Automation** (`actions`): trigger a specific cron job, so a button can run
  a real task (which may use a smaller model) without waking your main
  conversation.
- **Prompt** (`prompt`): send messages into your thread without the per-click
  confirmation that unapproved widgets require.

Enabled plugins can add their own named read-only feeds and actions to these capability lists; disabling the plugin removes those integrations.

Grants are bound to the exact widget bytes approved by your session policy.
Changed HTML or registered-source bytes require a new decision even when the
permissions stay the same or shrink. A grant is preserved only when the
approved bytes still match and the requested permissions do not widen.
The authoring result distinguishes pending, rejected, and granted access;
saving a widget does not imply its capabilities were approved.
Automatic review can reuse a low-risk approval when the same agent recreates
an HTML or registered-source widget with the same name, source, and declarations
in another session. This bounded in-memory reuse resets when the runtime
configuration or exec-approval policy changes. Each session's current permission
mode and each widget's grant authority still apply. MCP apps and incognito
sessions do not reuse these assessments. New content still waits for review.
Widget interactions the agent should know about (filters you clicked, views
you switched) reach it quietly as session notices — it stays informed without
being interrupted.

## MCP apps on the board

If your gateway has MCP servers configured, interactive MCP apps that appear
in chat can be pinned like any widget. Pinned apps come back to life on the
board with fresh sessions. By default they render without server tools or
same-server resource access. Granting the widget its declared server tools
enables both bridges while that revision-bound grant remains active.

## A2UI widgets

When the Canvas plugin is enabled, agents can render A2UI JSONL as a dashboard
widget. A2UI widgets use the same stable name, tab, size, pinning, sandbox, and
update-in-place behavior as HTML widgets. The renderer is loaded from the
Gateway's `/__openclaw__/a2ui/` asset route, so the renderer bundle is not
copied into each widget. The Canvas plugin and its hosted routes must be
enabled; both are enabled by default.

A2UI actions use the normal widget bridge. By default, clicks become quiet
session notices that the agent sees on its next turn. If the widget declares
and receives the `prompt` grant, its actions can instead send a visible prompt
into the thread. Disabling the Canvas plugin removes the A2UI kind and leaves
stored widgets visibly unavailable until the plugin is enabled again.

## Retired Workspaces

The experimental Workspaces plugin, its Control UI tab, `openclaw workspaces`
CLI, and `workspace_*` tools have been removed. Session dashboards use a
different storage model: each board belongs to a session and lives in the
owning agent's database. Legacy Workspaces documents and databases are not
automatically converted.

Preserve any legacy documents, data, and widget assets before running
`openclaw doctor --fix`: its Workspaces repair deletes identified legacy state
under `<stateDir>/workspaces`, without importing that content into a dashboard.

## Good to know

- Resetting a thread that has a board asks for confirmation and keeps the
  board.
- Deleting a thread deletes its board.
- Boards live on your gateway (in the owning agent's database) and appear on
  every device you connect from.
- Dashboard-enabled threads appear in `/dashboards`. Closing the Dashboard tab
  or side panel does not delete the dashboard or remove it from the gallery.
- The security model, storage details, and design rationale live in
  [Dashboard Architecture](/web/dashboard-architecture), including the
  documented sandbox tradeoffs.
