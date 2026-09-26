# OpenClaw GPUI

A native desktop chat client for multiple OpenClaw Gateways, built with GPUI Kit.
It provides an agent-scoped conversation sidebar, a composer with attachments,
and a streaming Markdown transcript. The Gateway owns conversations, model
selection, run scheduling, questions, and approvals; this app presents those
capabilities without starting or managing a Gateway.

## Build

This is a standalone Cargo project with its own lockfile, outside the `crates/`
workspace. Use Rust 1.98 or later. On macOS, install full Xcode for the Metal
toolchain:

```sh
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cd apps/gpui
cargo build
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The executable is `apps/gpui/target/debug/openclaw-gpui` when addressed from the
repository root. Release builds use `cargo build --release` and `target/release`.
Launch the executable to manage saved Gateways, use `--gateway <name-or-id>` to
open a saved profile, or use `--url` for an unsaved connection. For development
proof, use the isolated procedure in [Isolated proof](#isolated-proof).

macOS is the current development target. Linux and Windows builds and native
interactions have not been verified.

### macOS app bundle and Dock icon

From the repository root, run:

```sh
apps/gpui/scripts/bundle-macos.sh
```

The helper builds release and creates `apps/gpui/target/release/OpenClaw GPUI.app`.
An optional argument selects another `.app` output path; move an existing output
aside before rebuilding. It reads the version and target directory from Cargo,
sets the bundle identifier to `ai.openclaw.gpui`, and defaults the binary and
bundle's minimum macOS version to 12.0. Set `MACOSX_DEPLOYMENT_TARGET` to override
that minimum consistently for both.

The bundle icon reuses `apps/macos/Sources/OpenClaw/Resources/OpenClaw.icns`,
converted through `iconutil` with its original resolutions. The same artwork is
embedded in the executable and installed as the runtime Dock icon, so raw debug
launches also have the OpenClaw icon. Installing the icon does not activate the app.

The helper does not sign or launch the bundle. Unsigned builds are for isolated
development only; do not run them against saved Keychain items. If signing is
needed, use the repository's existing Developer ID flow rather than a separate
signer:

```sh
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/codesign-mac-app.sh "apps/gpui/target/release/OpenClaw GPUI.app"
```

See [macOS signing](../../docs/platforms/mac/signing.md) for that flow's
prerequisites. Follow [Isolated proof](#isolated-proof) for test launches; bundle
assembly and icon inspection do not require starting the app.

## Features

| Area | Available behavior |
| --- | --- |
| Conversations | Agent picker and All Agents roster, Home, New Chat, category/person/project/flat grouping, sort and ownership/archive filters, ten-row section paging, lazy child trees, unread/run/attention and pull-request indicators, title and Gateway transcript search. |
| People and navigation | Online users with avatars, idle state, facepiles and activity cards; profile identity menu; authenticated agent/owner/channel images; native Home and embedded Control UI administration/plugin routes. |
| Session actions | Inline rename, pin/unpin, read/unread, copy key, fork, archive with Undo, and confirmed transcript deletion. Shift-range/Cmd-toggle selection supports Gateway batch actions; row menus expose organization and ownership actions. |
| New chat | Cmd+N and sidebar + open an unsent draft with agent, destination, project/folder, current checkout or named worktree/base branch, group defaults, incognito, permissions, model/effort, and attachments. Local starts create and send together; remote starts create, dispatch, await placement, then send. |
| Composer | One-to-six-line growth, per-conversation drafts, history recall, slash-command completion, file picker/drop, clipboard images, large-text paste attachments, attachment-only sends, searchable provider and model-account selection, supported effort levels, fast mode and context-window choices, token/context usage when real totals are available, editable permissions, and a + menu for photos/files, skills, connectors, and web search overrides. |
| Transcript | Grouped messages, Markdown tables/task lists/links, highlighted code with a language/copy toolbar, attachment previews, thinking sections, humanized live/history tool cards, working phase and elapsed time, errors and stopped markers, older-history pagination, follow-tail and jump-to-latest. |
| Questions and approvals | Session-scoped question forms with choices, multiple answers, Other, masked secret answers, navigation and Skip; approval cards with command/change previews, expiry and Gateway-provided decisions. |
| Window | One window per saved Gateway, native Gateways menu and profile manager, custom title bar, collapsible 240–400px sidebar, system/light/dark appearance, connection status, reconnect countdown, and retry. |

The command palette searches loaded titles immediately and searches visible
transcripts through the Gateway. Opening a message match loads the conversation
and, when the message ID can be resolved, pages backward and reveals that message.
A message's Fork action is available when its history entry ID is present.

Slash commands are sent as ordinary chat text. While a run is active, Stop remains
available beside Send. The button becomes Steer only when the Gateway reports an
effective steering policy; otherwise the Gateway decides how to queue the send.
An optimistic user turn stays pending until acknowledged. A failed turn offers
Retry with its original idempotency key, or Discard. Delivery is never retried
automatically.

The model menu follows the Control UI catalog, including provider groups,
runtime alternatives, account availability, and the configured model's
**Default** badge. Search ranks model names before runtime, provider, and reference
matches. Effort uses the model's advertised levels; unsupported controls stay
disabled or hidden. Fast mode and context-window choices appear only where the
Gateway advertises them. Session changes update the chips immediately, then
confirm through `sessions.patch`; rejection restores the previous selection and
shows an error notification. Sending waits for an in-flight settings change.

The picker and effort controls share `model_controls_view(target, window, cx)`.
Call `set_model_controls_target(target, cx)` when entering a session or draft.
`ModelControlsTarget` contains `agent_id`, an optional `session_key`, and an
optional `draft_id` to distinguish multiple drafts for one agent. A draft target
never sends `sessions.patch`. Its creation owner reads
`model_controls_draft_patch(&target)` and applies those preferences when creating
the session, before sending the first message. The controls own catalog fetching,
account selection, capability projection, and optimistic session updates; the
creation owner continues to own draft submission and composer layout.

Shared UI building blocks live in `src/ui/components`: composer chips, anchored
control popovers, menu rows and surfaces, setting rows, provider icons, toggles,
and a discrete slider. They use GPUI component/base widgets for interaction and
`theme::tokens` for shared pixel/rem primitives, typography, colors, and surface
metrics. `theme::controls`, draft, and menu metrics consume those same primitives.
The slider uses the base slider's pointer state and exposes preview/commit
callbacks; the application owns only the target and the settings mutation.

Pure catalog, menu, and selection projections live in `src/model/model_controls.rs`,
`model_picker.rs`, and `model_selection.rs`. The UI state owns scoped RPC requests,
connection/target lifetimes, and pending mutations. Draft storage has one domain
owner, and the composer no longer maintains a parallel model catalog.
New-chat admission and its frozen creation request read the same draft selection;
account choices wait for the matching catalog to be ready. Asynchronous group
defaults refresh the existing form inputs before the next draft render.

Files are checked against the Gateway's advertised attachment limits. Clipboard
text longer than 1,000 UTF-16 units becomes a text-file attachment. Draft text and
attachments remain in memory, isolated by window and conversation. Remote
Markdown images are shown as links rather than fetched automatically; HTTP(S) links open
in conversation reading tabs.

Deleting a conversation first archives it, then requests deletion with its
session identity and `archivedOnly:true`, as required for `operator.write`.
If deletion fails after archiving, an error explains that the conversation
remains archived. Archive Undo restores the previous pin preference.

The layout follows Control UI density: single-line conversation rows, a compact
breadcrumb title bar, right-aligned user bubbles, and a 112px composer with its
model and effort controls in the bottom row. Question choices include their
descriptions inside the selectable buttons. Permission changes use the Gateway’s session access rules; Full Access requires administrator scope. Skill, connector, tool, and web search overrides are sparse session settings. The + menu also exposes managed skill revisions and native MCP server setup.

Instrument Sans is embedded under the SIL Open Font License, with system UI as
fallback. Static weights preserve native font matching; see the
[font derivation](assets/fonts/README.md). Message text uses 14px/1.6 line height.

Tool history and live events share invocation identity, including Gateway
`tool_call` dispatch wrappers and their concrete children. Completed results
remain settled across history refreshes. When a run finishes, errors, or stops,
any unresolved tools become muted **Interrupted** cards. Collapsed summaries
show the tool action and its primary argument; expanded cards retain full JSON.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Cmd+1 through Cmd+9 | Open or focus the corresponding saved Gateway; primary is Cmd+1 |
| Cmd+N / Cmd+Shift+O | Open a new-chat draft for the selected agent |
| Cmd+K | Open conversation search |
| Cmd+B | Collapse or expand the sidebar |
| Cmd+R | Refresh conversations and selected history |
| Cmd+[ / Cmd+] | Previous / next loaded conversation |
| Enter / Shift+Enter | Send / insert a newline; IME composition does not submit |
| Up at the start of the composer | Recall previous user inputs |
| Down during recall | Move forward, then restore the original draft |
| Up/Down/Home/End in slash completion | Navigate commands |
| Tab / Enter in slash completion | Complete / select a command |
| Up / Down in model search | Move through selectable results |
| Enter / 1–9 in the model menu | Choose the highlighted result / numbered result; digits type normally in search |
| Escape in model search | Clear the query first, then close the menu |
| Left / Right / Home / End in effort | Select a supported effort stop |
| Escape | Close a popup or Settings, or cancel rename; otherwise stop the active run |
| Enter / Escape during rename | Save / cancel; an empty title clears the manual label |
| Cmd+W / Cmd+M / Cmd+Q | Close window / minimize / quit |

The native Edit menu also provides Undo, Redo, Cut, Copy, Paste, and Select All.

## Connection configuration

### Saved Gateways and windows

Open **Gateways → Manage Gateways…** to add a named **Direct URL** or **SSH
tunnel** profile. The native manager also edits and removes profiles, reorders
saved entries with the arrow buttons, and sets the primary Gateway. A Direct
profile accepts an HTTPS/WSS address or hostname; SSH profiles use
`user@host[:ssh-port]`, a remote Gateway port (default 18789), and an optional
identity-file path. Remote Direct endpoints require TLS; loopback permits WS or
HTTP. HTTPS becomes WSS while preserving the Gateway path.

The **Gateways** menu lists the primary first, then a divider and the remaining
profiles in their saved order. **Cmd+1** through **Cmd+9** open or focus those
entries. Each profile has one window titled with its name and its own connection,
sidebar, chats, composer drafts, dock, and webviews. Selecting an already-open
profile focuses that window. A checkmark identifies the frontmost Gateway window.
Status dots follow the open windows' connection actors: green for connected,
yellow for connecting, orange for sign-in required, and white for offline.
Closed profiles show offline; the menu does not connect to them for a probe.

Normal launch opens the primary Gateway. `--gateway <name-or-id>` selects another
saved profile. A fresh installation with no profiles presents the connection
form and manager instead of automatically connecting to a local Gateway.
Existing installations import their last-used Gateway as a primary profile once,
preserving their device identity and pairing token. Closing a Gateway window
retires its connection and tunnel; quitting stops every window's tunnel.

Removing a profile deletes its saved credentials, pairing token when no other
profile uses that URL, and recorded Control UI and reading web stores. Its
Cloudflare Access session is removed when no remaining profile references that
origin. Cleanup failures retain a pending-removal record for retry through
[web-store maintenance](#macos-persistent-web-store-lifecycle).

When no profiles exist, **Import from OpenClaw for Mac** appears in the manager
if the Mac app's `openclaw.connectionMode` preference is `remote` and
`openclaw.remoteTarget` is valid. One click creates a primary SSH profile from
those two non-secret preferences, using remote port 18789. The import reads no
Mac app Keychain items and does not change the Mac app's preferences.

### SSH tunnels and credentials

Each SSH window launches its own non-interactive tunnel on a newly allocated
loopback port. The app never reuses another application's tunnel. SSH uses
`BatchMode=yes`, `StrictHostKeyChecking=yes`, `ExitOnForwardFailure=yes`,
`ControlMaster=no`, and server keepalives. Existing SSH keys and known-hosts
entries must already permit connection; establish trust in your terminal first
if SSH reports an unknown host. An optional identity file is passed as one
argument, including paths containing spaces. Tunnel readiness is checked before
connecting; failures and exits use the connection actor's retry/backoff path.
The child process group is terminated when the window closes or the app quits.

An SSH profile's stable Gateway identity is
`ws://127.0.0.1:<remote-gateway-port>/`, scoped by profile ID. The temporary local
forwarding port is only a transport address. Pairing tokens therefore survive
tunnel restarts without being shared with another SSH profile using the same
remote port.

The manager can save an optional Gateway token or password for each profile.
Saved credentials take precedence. Otherwise an SSH profile inherits literal
`gateway.remote.token` / `gateway.remote.password` only when the configured
transport is `ssh`, the parsed `gateway.remote.sshTarget` matches, and
`gateway.remote.remotePort` matches (default 18789). An omitted SSH port remains
distinct from explicit `:22`, because an SSH alias may configure another port.
This follows the Mac app's literal credential support and the Tauri app's
endpoint matching. SecretRef providers and the Mac app's Keychain are not read.
Without matching credentials, the app uses device pairing.

Direct profiles can inherit credentials from an exactly matching configured
remote URL, or local `gateway.auth` for the matching local endpoint. Saved
profiles do not inherit global `OPENCLAW_GATEWAY_TOKEN` or
`OPENCLAW_GATEWAY_PASSWORD` values, so those credentials cannot spill into an
unrelated saved Gateway. Config reads use `OPENCLAW_CONFIG_PATH`, otherwise
`OPENCLAW_STATE_DIR/openclaw.json`, otherwise `~/.openclaw/openclaw.json`.

### Profile CLI

The `gateways` commands seed and manage profiles without opening Gateway
connections. They print JSON containing profile metadata and IDs, never token or
password values. Run these examples from the repository root with your own hosts:

```sh
apps/gpui/target/release/openclaw-gpui gateways add --name Workstation --ssh user@gateway-host --primary
apps/gpui/target/release/openclaw-gpui gateways add --name Staging --url https://staging.example.com
apps/gpui/target/release/openclaw-gpui gateways add --name Shared --url https://shared.example.com
apps/gpui/target/release/openclaw-gpui gateways list
apps/gpui/target/release/openclaw-gpui gateways set-primary Workstation
apps/gpui/target/release/openclaw-gpui --gateway Workstation
apps/gpui/target/release/openclaw-gpui gateways remove Shared
```

`add` requires `--name` and exactly one of `--url` or `--ssh`. SSH accepts
`--remote-port <port>` and `--identity-file <path>`; quote paths containing spaces.
`--primary` makes the added profile primary. Optional `--token` or `--password`
saves a profile credential; use the manager's masked fields to avoid exposing
credentials in shell history or process arguments. `remove`, `set-primary`, and
`--gateway` accept a name or ID. `OPENCLAW_GPUI_STATE_DIR` selects the same private
store for CLI and GUI. Close the GUI before running `add`, `remove`, or
`set-primary`; these mutations acquire the app's session lock and refuse while
it is running. `gateways list` remains available while the GUI is open. Store
writes also serialize across processes.

### Unsaved connections

`--url`, `--token`, and `--password` still launch an ad-hoc, unsaved connection:

```sh
apps/gpui/target/release/openclaw-gpui --url ws://127.0.0.1:19471 --token '<GATEWAY_TOKEN>'
```

Each ad-hoc field resolves independently: CLI first, then
`OPENCLAW_GATEWAY_URL`, `OPENCLAW_GATEWAY_TOKEN`, or
`OPENCLAW_GATEWAY_PASSWORD`, then the JSON5 OpenClaw config. If no CLI or
environment URL is supplied, the legacy last-used URL takes precedence over the
config. Local config uses `gateway.port` (default 18789) and `gateway.auth`;
`gateway.mode: "remote"` uses `gateway.remote.url` and its token/password.
Only literal credentials are supported. Failed connections expose the editable
URL and masked credential fields. These launches do not create saved profiles;
use an explicit isolated URL and state directory for development proof.

### Remote Gateways and Cloudflare Access

For a Gateway protected by Cloudflare Access, save a Direct profile or run an
unsaved connection from the repository root:

```sh
apps/gpui/target/release/openclaw-gpui --url https://gateway.example.com
```

The app checks the Gateway and verifies its signed Cloudflare Access metadata.
When the form says **This Gateway uses Cloudflare Access**, choose **Sign in
with browser** and finish the login in your default browser. The app waits for
the encrypted token transfer, verifies the app token's signature, audience,
issuer and expiry, and confirms the identity before connecting. No `cloudflared`
installation is needed. The browser opens only after an explicit click;
**Cancel** stops the attempt. Token and password fields are hidden for Access
Gateways, and shared Gateway credentials are omitted from their handshake.

The Access token authenticates the WebSocket upgrade using `Cf-Access-Token`.
The app still signs with its own device identity. If device approval is required,
follow the Gateway's remediation message and choose **Retry** after approval.
A valid Access session survives that pairing wait and is reused on relaunch.
Every reconnect reads the current session; an expired or rejected grant asks
you to **Sign in again** instead of reopening the browser.

The sidebar footer shows the Gateway profile display name and avatar, with the
signed-in Access identity as a connection fallback. **Switch Gateway…** disconnects and returns to the form. **Sign out**
closes the connection, removes the saved Access session for that origin, and
removes the window's embedded Control UI web session on macOS 14+. Other windows
for the same origin read the current Access session on their next reconnect.
It keeps the app's device identity and per-Gateway pairing token. Signing out of
the app does not sign out of your browser's Cloudflare account.

Access sessions (app token, subject/email, expiry, origin, issuer and audience)
share the private `identity.json` file with profiles and device identity.
Sessions are indexed by HTTPS origin and reused by windows for that origin,
separately from pairing tokens and each profile's embedded web stores. Organization tokens are never retained. Session debug output
redacts credentials, and HTTP requests use bounded bodies, no redirects and no
cookie store.

For read-only diagnostics without starting the GUI, reading app state, opening a
browser, or making a WebSocket connection:

```sh
apps/gpui/target/release/openclaw-gpui --probe-access https://gateway.example.com
```

It prints the verified application origin, audience and issuer when Access is
detected. Debug builds also support the render-only
`OPENCLAW_GPUI_CONNECT_FIXTURE=url|waiting|error` screenshot fixtures; these
disable connection and browser actions and are ignored by release builds.

CLI credentials may be visible in process arguments. Environment variables or
the masked connection form avoid placing credentials in command history.
`OPENCLAW_GPUI_LOG=openclaw_gpui=debug` enables connection, request, and stream
diagnostics without logging credentials or message contents.

### Device identity and isolation

The app signs the Gateway's nonce with a persistent Ed25519 identity and requests
`operator.read`, `operator.write`, `operator.approvals`, `operator.questions`, and
`operator.admin` (for the native agent-browser surface).
Its secret key, profiles, primary selection, optional profile credentials,
Access sessions, and issued device tokens live in `identity.json` under the
directory selected by `OPENCLAW_GPUI_STATE_DIR`. Direct pairing tokens use the
canonical Gateway URL; SSH pairing tokens use the profile ID and remote Gateway
URL.
An explicitly empty override fails instead of falling back.

Without that override, the directory is `dirs::config_dir()/openclaw-gpui`:

- macOS: `~/Library/Application Support/openclaw-gpui`
- Linux: `$XDG_CONFIG_HOME/openclaw-gpui`, usually `~/.config/openclaw-gpui`
- Windows: `openclaw-gpui` under roaming application data

On Unix the directory is mode 0700 and the atomic replacement file is mode 0600.
Ad-hoc Gateway credentials stay in memory; explicitly saved profile credentials
share that private file. The empty mode-0600 `identity.lock` file serializes
atomic state replacements across CLI and GUI processes. A second empty
mode-0600 `app-session.lock` prevents CLI profile mutations while the GUI is
running. Existing root-URL device-token keys
are normalized to a trailing slash without replacing the identity. The app never
uses the CLI's device identity. Local connections normally auto-pair;
remote connections may require operator approval. A remediation message pauses
reconnect when user action is required. Transient failures use exponential backoff
and the Gateway's advertised traffic-watchdog policy.

**Setting `OPENCLAW_STATE_DIR` alone does not isolate the GPUI device identity.**
Proof launches must also set `OPENCLAW_GPUI_STATE_DIR` and explicitly select the
isolated Gateway URL and token.

## Architecture

[`src/gateway`](src/gateway) owns transport, configuration, identity, the event
router, and typed method parameters/results. One multithreaded Tokio runtime owns
network requests. Blocking identity and attachment-file I/O runs off the GPUI
thread. A bounded asynchronous channel delivers connection/events to GPUI;
oneshot channels return RPC results. The GPUI thread owns view entities and
never waits synchronously for network requests.

The connection actor owns Access discovery, explicit browser transfer,
transport retirement and session persistence. It rebuilds the upgrade headers
from current state for each attempt. Since the shared Rust transport flattens
HTTP upgrade failures, an authenticated HTTP probe distinguishes rejected
Access grants from ordinary connection failures without changing that crate.
State writes reread the latest file under a process mutex and file lock;
cancellation, current-profile checks, and matching token checks keep stale
attempts from restoring a removed profile's credentials or invalidating a newer
grant. `gateway_windows.rs` owns the window catalog and native Gateways menu;
`gateway/profiles.rs` owns saved routes and `gateway/remote_tunnel.rs` owns SSH
child processes.

The event router owns the roster subscription and the selected session's message
subscription lifecycle. Session switches serialize unsubscribe/subscribe work;
reconnect re-subscribes and reloads selected history. It routes `sessions.changed`,
`chat`, `agent`, `session.tool`, `session.approval`, questions, presence, and
shutdown. Pending questions are also read on connect. Results are fenced by
connection epoch, agent, conversation selection generation, and request receipt,
including switch-away-and-back and deferred foreground navigation.

[`src/model`](src/model) contains pure reducers for roster reconciliation,
transcripts, tool streams, turn grouping, composer drafts/history, commands,
attachments, questions, approvals, sidebar filtering/grouping/selection, presence
projection, avatar policy, and pull-request snapshots. Gateway row snapshots update admitted
roster rows; events never create list membership. Uncertain membership schedules
a fixed five-second coalesced refresh, with a five-to-fifteen-second cooldown
based on the previous read's duration. Explicit refresh bypasses that pacing.
Optimistic edits retain rollback fields, and older failures cannot undo newer
edits. A slow list read cannot replace a newer event receipt.

[`src/ui`](src/ui) separates sidebar/session actions, header/search, composer,
transcript, attention forms, and theme. Theme tokens are centralized in
[`theme`](src/ui/theme.rs), with measured sidebar metrics in
[`theme/tokens.rs`](src/ui/theme/tokens.rs). Shared building blocks in
[`components`](src/ui/components) own avatars, facepiles, image caching, icons,
list geometry, and popup/hover-card placement. The per-Gateway image cache owns
request receipts, eviction, retries, and cancellation; views only request sources
and render its results. GPUI Component supplies inputs, menus, command
search, dialogs, notifications, Markdown, syntax highlighting, and other controls.
The variable-height transcript uses GPUI's virtualized list. Parsed Markdown and
images are cached per selected conversation; streaming invalidates changed rows
instead of rebuilding every completed message. Prepending history preserves the
visible scroll anchor.

## Isolated proof

Set `OPENCLAW_GPUI_BACKGROUND=1` to open or reuse windows without activating
the app. Use an isolated `HOME` and `OPENCLAW_GPUI_STATE_DIR`, and an explicit
synthetic endpoint such as `--url ws://127.0.0.1:9 --token synthetic`.
This controls app activation; it does not change macOS accessibility semantics.

The `steipete/gpui-bgtest` branch patches `gpui-component` and `gpui-base` to
the local `~/Projects/oss/gpui-kit` checkout for accessibility validation.
The component patch exposes press actions for enabled popup-menu submenus,
including Appearance, so background automation can navigate them with element
clicks. Disabled submenu rows remain noninteractive.
It also patches `accesskit_macos` to `~/Projects/oss/accesskit/platforms/macos`
to expose each inactive window's internally focused element. The matching
`accesskit` and `accesskit_consumer` paths keep the adapter's workspace dependencies
on the same crate identities; their versions and source behavior are unchanged.
The `gpui-pre-macos` patch at `~/Projects/oss/gpui-pre-macos` attaches the adapter
to the rendering view that serves as AppKit's first responder.
The Wry patch at `~/Projects/oss/wry` prevents hidden or unfocused child
webviews from activating the application during construction.
These absolute Cargo paths are local proof wiring and must be replaced with
released dependencies before shipping the app.

Keep the target window partly visible during background proof. On macOS, GPUI
stops drawing fully covered windows, which also leaves their accessibility tree
stale. Moving only the target window into unused desktop space through AXPosition
restores rendering without focusing or raising it.

Sidebar proof uses the durable directory
`/Users/steipete/Projects/openclaw-campaign-backup/gpui-proof`, with launchers and
logs in `sidebar-rig/`, screenshots in `shots-sidebar/`, the source inventory in
`sidebar-gap-table.md`, and outcomes in `sidebar-report.md`. The earlier task
scratchpad was removed; its launchers and screenshots are not available.
No proof artifacts belong in this app directory or `/private/tmp`.

Run the retained scripts from the repository root. Set `GPUI_PROOF_DIR` to the
durable directory and `GPUI_RIG_DIR="$GPUI_PROOF_DIR/sidebar-rig"`. The rig uses
this checkout's built Gateway and QA mock model provider, synthetic profiles and
sessions, free loopback ports, and isolated HOME, XDG, config, Gateway state,
GPUI state, and temporary directories. `start-people.mts` adds isolated local
identity proxies and simultaneous operator clients for presence proof; it never
uses saved accounts or production Gateways. Its private `connection.json`
contains the synthetic token and must not be printed or shared.

Before starting, record `ls -la` and `stat` for the real GPUI state directory and
its entries without reading file contents. Preserve every app process not
started by this proof. Start each long-running launcher in a separate managed
task. Build the web bundle with `pnpm ui:build`; if its trailing default-output
asset check fails, the retained `vite.config.mts` builds this checkout's UI into
`sidebar-rig/control-ui`. Record that fallback accurately instead of reporting
the wrapper as passing.

```sh
node --import ./scripts/tsx.mjs "$GPUI_RIG_DIR/start-people.mts"
```

Once the Gateway is ready, `seed.mjs`, `seed-folders.mjs`, and the retained
project/attention seed helpers prepare synthetic data. Build the debug binary
with `cargo build --manifest-path apps/gpui/Cargo.toml`, then run
`node "$GPUI_RIG_DIR/app-launch.mjs"` in another managed task. The launcher always
sets `OPENCLAW_GPUI_STATE_DIR` and supplies explicit isolated `--url` and `--token`
arguments to `apps/gpui/target/debug/openclaw-gpui`. Never launch through Finder,
`open`, an app bundle, or a saved Gateway profile. Build release only after proof.

`native-step.py` verifies the recorded executable/PID and records `lsof` before
and after each native automation step. Every app Gateway socket must remain on
the isolated loopback ports; port 18789 and external Gateway addresses are
forbidden. Scope capture/automation to that owned process only. Capture native
and web at the same 1200×800 logical window size and inspect complete images for
layout and incidental data.

`web-session.mjs` owns a separate headless Playwright browser at 1200×800;
`web-action.mjs` operates it through a loopback control endpoint. Use that browser,
never a personal browser session. `rpc.mjs` reads authoritative rig state to
corroborate native actions. A direct RPC mutation or screenshot alone does not
prove the native control works; distinguish live Gateway evidence from seeded
or unit-only states in the report.

Stop only recorded proof-owned app, browser, Gateway, provider, and operator
client processes through their launchers. Remove recorded isolated WebKit stores
before deleting the exact task-owned runtime roots. Retain the requested scripts,
logs, screenshots, gallery, gap table, and report. Compare the real state directory's
final metadata with the initial record without reading its files. The report owns
actual verification results; these instructions do not assert that proof passed.

## Known limits

This native chat shell embeds Control UI administration pages and conversation panels.
Separate native administration pages are not implemented. Saved Gateways open or
focus their most recently used window; holding Option in the native Gateways menu
shows **New <name> Window** for an independent window. Command+1…9 selects a
Gateway, and Command+Option+1…9 opens another window. The primary Gateway comes
first; a checkmark follows the active Gateway window. Native macOS rows retain
accessible exact names with status images and, on macOS 14+, Primary/status
subtitles. The Swift app’s custom version/latency cards are not reproduced.
The footer identity menu uses the same profile/status owner, opens Gateway windows,
and persists **Set as primary…** through the existing profile store.
**Gateway settings…** opens Manage Gateways. **OpenClaw → Sign Out of Gateway…**
retains native account and web-store sign-out independently of the identity menu. Sidebar
images load only from authenticated Gateway avatar routes or supported inline
agent images; third-party image URLs use the same fallback policy as the web.
Plugin theme hats and system-agent mascot branding are not reproduced natively.
Child loading admits the first 100 children, displaying four before Show more.

Sidebar filters, grouping, sort, section collapse, navigation choices, and All
Agents mode persist per Gateway in the existing app state file. Drafts (including new-chat settings and unconfirmed submission recovery), appearance
override, sidebar width, child expansion, and image caches remain in memory and
reset when the app exits. Drafts are isolated by Gateway; an uncertain create retains its request identity, and placement or first-message failure retains the created session key. A retry resumes that operation instead of creating another chat. Desktop photo actions use the native file picker; direct camera capture is not provided. Person initials preserve composed Unicode characters
on macOS; other platforms currently use Unicode scalar initials. There is no local `/clear` interception.
Question/approval options, attachment limits, model availability, and thinking
levels depend on the connected Gateway. Inline history image previews require
supported image data in the history response; other attachments appear as chips.
Actual native interaction and visual-proof results belong to the retained proof
report, separately from unit tests or protocol fixture results.

## Embedded Settings and conversation panels

The sidebar navigation and identity menu open the connected Gateway's matching
Control UI routes in the main content area. **Settings…** and **Cmd+Shift+,** open its
appearance settings. The conversation sidebar remains native;
**Done** in the main breadcrumb bar or Escape returns to chat. **System busyness** (Cmd+Shift+D) invokes the Control UI’s existing debug overlay.
**Pair device** opens Devices settings, where the existing **Pair device** button
opens the pairing dialog; the web app has no native pairing command to invoke directly.
The Gateway must serve the Control UI
from this worktree for the new panel route to be available.

The right-hand panel dock has a native tab strip, picker, close controls, a resize
divider, collapse, and expand/restore. Layout and reading tabs stay in memory per
Gateway/agent/conversation. Widths follow the web owner: 480px default, 260–1200px
limits, and a fitted maximum of 60% with space reserved for chat. Closing a live
Browser/Desktop resource, or explicitly collapsing the dock, suppresses automatic
resource reveals for that conversation. A session switch presents only that
session's retained views; closed panels drop their webviews.

| Surface | Content owner |
| --- | --- |
| Browser → Reading tabs | Native tabs, URL entry, back/forward/reload/stop, loading/title, external-open button; wry renders websites. HTTP(S) transcript links open here after the existing plugin link-reader owner gets first refusal; relative file links open Files. Mailto/tel use the system handler. New windows become reading tabs in the same conversation. |
| Browser → Agent browser | Native GPUI image viewer and controls, using the Gateway's existing `browser.request` and authenticated screencast contracts. Pointer, keys, pasted text and scroll are forwarded serially. Unsupported screencasts use explicit screenshot refresh. Availability requires the advertised method and granted administrator scope. |
| Tasks, Terminal, Files/workspace, Side chat/companion, Conversation, Dashboard, Desktop, Review/detail, Discussion, Portals, Link reader, plugin panels | Existing Control UI panel components in wry, using `/apps/panel?agent=…&session=…&slot=…`. Availability and resource discovery come from the web owner's live session/plugin state. |

The metadata-only `slot=picker` route publishes available panels, live resources,
and exact browser targets without mounting panel components or the composer.
Embedded panels reuse ChatPane's Gateway data owners and lazy loaders. They have
no application sidebar, global docks, or composer. Their layout is isolated from
saved browser layouts. Route targets include the literal agent/session identity
and optional task, portal, and environment IDs; a keyed remount fences replaced
sessions. Native requests from embedded panels preserve those target IDs.

Panel shortcuts match the web: **Ctrl+`** Terminal, **Cmd+Shift+B** Files,
**Cmd+Shift+S** Side chat, and **Cmd+Option+Shift+U/K/D/J/G/E** for Browser,
Tasks, Desktop, Discussion, Dashboard, and Review respectively. Web content
forwards app shortcuts through a document-start, nonce-checked bridge. Clicking
native chrome restores GPUI focus. The app requests the Control UI's
`operator.admin` scope in addition to its previous operator scopes for native
agent-browser operations; the Gateway's pairing and authorization policy still
owns whether it is granted.

### Webview architecture and platforms

`ui/web_state.rs` owns a bounded webview pool for each connected window: one
hidden Control UI spare in that Gateway's existing store and one hidden blank
spare in the reading store. Warming starts after the connected window paints.
The Control UI spare loads Appearance with the normal authentication bootstrap;
its native command listener and Gateway connection must both be ready before
adoption. Settings, pages and panels navigate the adopted document through the
Control UI's native router bridge, preserving its connection. Adoption schedules
a replacement after the next frame. A fast open before readiness uses a normal
cold surface. Gateway switches, sign-out, profile removal and window closure
retire both spares and cancel pending replenishment. Warm views never activate
the app, become visible, or take focus, including in background proof mode.

`ui/webview_surface.rs` owns each direct wry child webview, attached to GPUI's
window handle. Paint synchronizes its logical bounds
with pixel alignment at the window's scale factor. Inactive surfaces are hidden
and retained. GPUI overlays hide intersecting surfaces; component menus, dialogs,
sheets and notifications conservatively hide all native webviews when their
precise bounds are unavailable. Callback events use a bounded wake channel into
GPUI rather than polling. Native appearance updates WebKit/WebView2's preferred
color scheme without changing the system setting.

Each visible surface keeps a theme-matched native loading placeholder until its
document is ready. The Control UI reports typed, generation-scoped presentation
state after the shell, route, and shared loading surfaces settle; empty and
error states are revealable. Navigation masks the previous document before the
next route renders. Two drawable web frames precede reveal. Reading documents
wait for load, fonts and two drawable frames; a blank reading tab keeps a native
empty state instead of showing a white page. Third-party applications' later
asynchronous updates remain owned by those sites.

On macOS, a transparent native container lets WebKit finish rendering without
displaying intermediate frames or intercepting clicks. Its bounds stay fixed
during loading. The patched wry constructor respects hidden/unfocused webviews;
`gateway_windows.rs` retains the `OPENCLAW_GPUI_BACKGROUND` window-activation
switch. Native webviews keep their original WebKit class and observation state.

`webview_open` diagnostics record request-to-reveal timing. Fully occluded windows
may have drawing paused by macOS; background frame proof uses an unobscured
window without activating it.

| Platform | Support and storage |
| --- | --- |
| macOS 14+ | WKWebView child surfaces with persistent identifier-based stores: one Control UI store per app state root, profile, and Gateway origin, plus a reading store per profile. Unsaved windows retain the legacy origin/reading scopes. Web identity and cookies survive app restarts. WebKit chooses the physical storage location; `OPENCLAW_GPUI_STATE_DIR` isolates the identifier namespace, not the WebKit directory. |
| macOS before 14 | Ephemeral Control UI and reading stores scoped by profile; unsaved windows use the legacy scopes. A one-time warning explains that web sessions do not survive restart. The default global WebKit store is never used. |
| Windows | WebView2 child surfaces; persistent profile/origin-specific Control UI and profile-specific reading directories under `OPENCLAW_GPUI_STATE_DIR/webviews` (or the normal app state directory). Implementation is platform-gated; runtime proof remains macOS-only. |
| Linux | No wry/GTK dependency. Surfaces render an **Open in browser** link using `cx.open_url`; there is no embedded Settings/panel/browser rendering. The native agent-browser renderer is separate from this stub. |

### Authentication handoff

Token/password Gateways use exactly the native hosts' document-start
`__OPENCLAW_NATIVE_CONTROL_AUTH__` bootstrap, scoped to the Gateway origin and
Control UI mount path. The Control UI consumes it using its normal connection
owner and creates its own browser device identity. All authenticated panels use
one shared store within that profile, while reading websites receive no Gateway credentials or
native device-settings bridge. The native embed contract's `navigationChrome:
"host"` option gives the native breadcrumb and Done control ownership of page
navigation, hiding the web's duplicate Back/title. Route-local controls such as
Automations' job-scope filter remain on the page. Webview back/forward uses
`__OPENCLAW_NATIVE_HISTORY__` and `NATIVE_HISTORY_STATE_EVENT` with the actual
history state. No native device capabilities are invented: without the device
settings bridge the existing web app-only state is shown.

For Cloudflare Access, the connection actor passes its verified, unexpired,
origin-bound application grant. Before the initial document loads, the surface
sets the secure HttpOnly `CF_Authorization` cookie through WKHTTPCookieStore or
WebView2 CookieManager and sends `Cf-Access-Token` on the initial navigation.
The app does not assume a header-only navigation will create a cookie. Shared
Gateway credentials are explicitly null for this mode. An Access redirect can
complete an interactive login in the webview; macOS 14+ retains its cookies
across launches. Explicit app sign-out removes that profile's Control UI store.
Live Access validation results belong to the separate proof report.

### macOS persistent web-store lifecycle

`identity.json` records WebKit store identifiers before creation. The identifier
is the first 16 bytes of SHA-256 over `org.openclaw.gpui.web-data-store.v1\0`,
the canonical state-root path byte length (u64 big-endian), its native path
bytes, and the store scope. Saved profiles use
`profile:<id>:control:<HTTP(S) origin>` and `profile:<id>:reading`; unsaved
connections retain `control:<HTTP(S) origin>` and `reading`. SSH Control UI scopes
use the canonical remote origin, so a new local tunnel port cannot change store
identity. UUID version 8 and RFC 4122 variant bits are set. Mount paths within a
profile share their origin's store; different profiles, origins, roots, and
reading stores have distinct identifiers. Symlink aliases of the same root
resolve to the same identifier. Windows stores saved-profile data under
`webviews/profile-<scope-hash>`, preserving legacy directories for unsaved
connections.

Sign out destroys all retained Control UI webviews, awaits native view release,
clears website data (including service workers), and awaits store release before
removing the identifier once. WebKit can retain a worker for about 10 seconds;
the store-release budget is 30 seconds and the UI shows “Signing out…” meanwhile.
Clearing uses WebKit's public completion handler because wry's clearing method
returns immediately. Identifier removal/listing use wry's public Darwin APIs.
Only identifiers recorded by this root, and matching its derivation, are eligible.
A pending-removal record blocks reuse and is retained on error or interruption;
retry Sign out or use the maintenance command after quitting all app instances.
Reading data survives Gateway sign-out. Removing a profile through Manage
Gateways or the CLI removes its recorded Control UI and reading stores. Migration
assigns the legacy Control UI store for the old Gateway to its imported profile;
unattributed legacy reading data remains available to web-store maintenance.

To inspect or remove **all recorded stores** for an explicitly selected state
root (including reading data and interrupted removals), quit that app instance:

```sh
OPENCLAW_GPUI_STATE_DIR=/absolute/state/root target/debug/openclaw-gpui --web-data-stores list
OPENCLAW_GPUI_STATE_DIR=/absolute/state/root target/debug/openclaw-gpui --web-data-stores remove
```

These macOS 14+ commands open no window and load no Gateway config. Listing
intersects WebKit's identifiers with this root's records; removal verifies the
removed identifiers are absent from WebKit before success. Remove stores before
deleting a temporary state root: the record is the authority for cleanup.
