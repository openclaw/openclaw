---
summary: "Chrome extension: securely automate signed-in tabs with automatic local pairing"
read_when:
  - You want an agent to drive your signed-in Chrome without remote-debugging prompts
  - You are installing, pairing, disabling, or troubleshooting the OpenClaw Chrome extension
  - You need the Chrome native bootstrap security and platform support model
title: "Chrome Extension"
---

# Chrome extension

The OpenClaw Chrome extension lets the browser tool automate eligible tabs in
your signed-in Chrome profile. It uses `chrome.debugger`, so it does not require
Chrome's blocking remote-debugging consent prompt.

The extension is browser automation infrastructure. It does not include chat,
page sharing, a prompt box, or a tab copilot. Its popup shows connection state,
the current access mode, a Pause/Allow action for the current eligible tab, and
a Settings link.

## Requirements

- Google Chrome, Chrome for Testing, or Chromium
- OpenClaw installed on the same machine as Chrome, or an OpenClaw browser node
  on that machine
- macOS/Linux, or Windows with the self-contained OpenClaw native bootstrap executable
- For browsers other than Google Chrome on macOS, launch the browser at least
  once so its user-data directory exists

Windows uses `OpenClaw.BrowserBootstrap.exe`, not a batch or PowerShell launcher.
Setup discovers the packaged helper or the Windows companion installation. Portable
installations can select its absolute local path with `--native-host-executable`.
The shared Windows registration service owns native registration and Store requests.
The standalone Windows CLI delegates through the executable’s bounded management
interface, explicitly binding its Windows Node/CLI, state directory, config path
and browser profile. The Companion uses its separate managed-WSL mode and live
Gateway authority. Neither mode falls back to the other when unavailable.
Private, verified generations live beneath the current user’s Local App Data
OpenClawTray directory. The service proves binary framing and admission before
registering Chrome/Chromium in both applicable user registry views. It will not overwrite a
foreign registration, shadow a machine registration, or treat WSL/UNC paths or
an SSH loopback URL as local Windows authority. Missing/incompatible executables
or unsafe ACLs keep setup blocked; there is no script fallback or copied-key prompt.
A different existing mode/context or legacy unrecognized registration is preserved
and reported as a conflict, not silently replaced. Interrupted management with no
clean receipt is an unknown outcome: inspect the same context before retrying.
Windows Store removal uses `extension uninstall-host --remove-store`; this removes
owned Store requests first and then owned native registration. The macOS
`uninstall-store` command continues to leave native registration unchanged.

## Install

Run this command on the machine that hosts Chrome. Google Chrome on macOS can
be prepared before its first launch; other supported browsers need to be
launched once first. See [`openclaw browser`](/cli/browser) for the full
`browser extension` subcommand reference:

```bash
openclaw browser extension install
```

Keep the command running while you complete Chrome's setup. On macOS, it first
registers the native host, then asks Google Chrome to install the official
Store extension. Chrome discovers the request at browser startup. If Chrome is
already running, fully quit and reopen it when convenient, then approve or
enable **OpenClaw** in Chrome. OpenClaw never restarts Chrome or approves its
permission prompt for you. The request applies to all profiles in that Chrome
user-data directory. Chrome controls approval in each profile.

The native macOS app prepares this automatically after primary launch and
after successful CLI installation or updates. Packaged apps use their validated
private runtime, so a remote-only Mac does not need a separate CLI install.
Automatic registration belongs to the default app profile; named profiles keep
explicit setup because Chrome shares one native-host registration per user.

**Dashboard → Settings → This Mac → Browser → Set up Chrome on this device** retries
the same serialized canonical setup controller. It always prepares this Mac,
not the remote Gateway. Browser setup and the native helper read configuration
without Gateway-wide Doctor or migration of an independently managed Gateway
database. Ordinary browser commands still report invalid configuration. A
browser-based dashboard provides Store and setup-guide links rather than
installing software locally.

The Tauri desktop app also prepares the local helper at startup and after local
CLI setup. Release builds can provision a matching browser-only runtime in their
app-data directory without changing a Gateway service or its installed code.
Use **Set Up Chrome Extension…** in the tray to retry and open the official Store
after registration succeeds. Startup never opens Store windows or undoes Chrome
removal/disable choices. Development builds need an existing CLI, and Windows
Tauri test builds do not provision this runtime. Remote-only desktop connections
still need a browser node on the Chrome host to expose its tabs to the Gateway.

The **This Mac** page checks installation when opened and when you return from
Chrome. An existing extension shows **Installed**, including when Chrome still
needs you to enable it. If its local helper is missing, **Set up Chrome on this device**
repairs automatic pairing without treating the extension as absent. **Refresh setup
status** refreshes this status without installing anything. Installation status
does not prove a live connection; open the extension to check that separately.
Older Mac app versions keep their setup action when automatic status checks are
unavailable. Update the Mac app to detect an existing installation without
running setup.

On Linux and in other supported Chromium browsers, add
[OpenClaw from the Chrome Web Store](https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig)
after native-host registration succeeds. Linux does not support this per-user
Store installation request. On Windows, add the Store extension after the native
executable has passed setup. Supported same-host pairing then happens through the
native channel without copying a key. Chrome still owns its installation and
permission approval.

You can also use the Store link if Chrome does not offer the requested install.
If you previously removed the extension, Chrome remembers that choice. Explicitly
add it again from the Store. OpenClaw does not clear Chrome's removal decision.

On macOS and Linux, the origin-locked native host permits the exact official
Store identity and OpenClaw's deterministic development IDs. Once enabled, the
extension pairs on its first native call. The installer inspects the profile's
`Preferences` and `Secure Preferences`
backing files and verifies the exact Store ID independently from any extension
path. Chromium selects the backing file by settings-enforcement policy. Linux
normally uses `Preferences`. Both files receive the same ownership, path, file
type, permission, and size checks.

For extension development, skip creating a Store installation request:

```bash
openclaw browser extension install --no-store
```

This still copies the bundled extension to a stable OpenClaw-owned directory
and registers the native host. It leaves any existing Store request unchanged.
Use the unpacked copy as a development fallback:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the path printed by the command.

Leave the install command running while completing either Store or development
setup. For unpacked development, the installer verifies that Chrome loaded the
approved realpath under its predicted deterministic ID.

The installer recognizes the official Store installation only by the exact
Foundation Store ID. That identity never makes a recorded path OpenClaw-owned.
For unpacked development, it accepts an ID only when all of these are true:

- the ID matches Chrome's 32-character extension ID format.
- Chrome records the install location as unpacked.
- the recorded extension path resolves exactly to the installed or bundled
  OpenClaw extension directory.
- the recorded ID equals Chromium's deterministic path ID for that exact
  canonical realpath.

The extension name is not trusted. Existing native-host files with the same
host name are not overwritten unless they are verifiably OpenClaw-owned.

Use a different bounded wait when needed:

```bash
openclaw browser extension install --wait-ms 60000
```

For automation, use `--json`. The result reports Store installation requests,
Store discovery and approval, approved unpacked IDs and paths, and native-host
registration health separately. These local observations do not prove a live
connection. Verify the extension's connected state and run
`openclaw browser --browser-profile chrome tabs` against the intended Gateway
or browser node. JSON output never includes a relay key or pairing string.

## Shared setup controller

CLI, native desktop adapters, and the terminal setup flow use the same Browser-owned
controller on the machine that hosts Chrome.

Setup's installation status describes Google Chrome. The
`openclaw browser extension install` and `openclaw browser extension status`
commands also support Chromium and Chrome for Testing.

```bash
openclaw browser extension setup --action inspect --json
openclaw browser extension setup --action install --json
openclaw browser extension setup --action verify --browser-profile chrome --json
```

`inspect` reads installation state without installing or connecting. `install`
prepares automatic local bootstrap; Chrome still owns extension installation and
permission approval. There is no pairing code to copy for supported local native
bootstrap. Existing pairings and an explicit automatic-setup opt-out remain intact.
`verify` authenticates the exact local profile relay with the existing per-host
key. It does not create a key, start another relay, or fetch a remote Gateway key.

On macOS and Linux, a supported bundle-path migration retains the saved profile
from the validated private manifest and launcher. The existing one-slot origin
migration rule is unchanged: until repair, the registration is owned but not
ready for the new bundle. Older launchers without a saved selector retain their
original selection: the first configured extension profile, independently of
`browser.defaultProfile`. Selector-free setup refuses an unverified or foreign
registration. Explicit `inspect` and `verify` requests must match the registered
profile; use `setup --action install --browser-profile <name>` to change it.
An explicit selection cannot bypass ownership or origin checks. Setup does not
rotate the existing relay key or rewrite Chrome pairing preferences.

Setup also preserves the registered state and configuration selection. If the
current process uses a different configuration, it stops before installation or
relay access. Rerun with the matching `OPENCLAW_STATE_DIR` and
`OPENCLAW_CONFIG_PATH`; choosing another browser profile does not authorize
changing the configuration file. An implicit default config and its explicit
path count as the same selection. Setup rechecks the saved selection before
publishing a replacement native-host manifest.

On Windows, omitted profile selection uses bounded, serial read-only inspection of
already-configured extension profiles. Only a current matching C# registration
descriptor, independently validated against its binding and requested context,
can select a saved profile. Setup confirms that observation before proceeding;
the C# owner revalidates the single installation operation. Unknown, conflicting,
changed, or unavailable evidence never silently selects `chrome`. A genuinely
missing registration can use the existing fresh-install default.

If the saved profile is no longer configured, or the Node/CLI paths or approved
extension origins have changed, the Windows contract may return no matching
descriptor. Automatic selection then stops without an installation attempt.
Review the intended existing profile and repair explicitly, for example
`openclaw browser extension setup --action install --browser-profile work`. This
is not automatic runtime-upgrade recovery: a different state, configuration,
profile, or Companion mode remains a context conflict rather than a takeover.

The JSON result contains `action`, a `target` with `kind: "local-host"`, platform,
hostname, profile and relay port, plus `phase`, `reason`, `installation`,
`connection`, and `nextAction`. Installation reports count installed profiles
separately from enabled profiles, so a disabled extension is not presented as
missing. Valid pending or blocked results exit successfully;
command or execution failures exit nonzero. Results never contain pairing strings
or relay keys. Existing `install` and `status` commands retain their documented
output formats.

Installation, Chrome approval, and authenticated connection are separate facts.
`ready` means the selected relay has an authenticated extension; it does not mean
there are eligible tabs. An empty tab list is not a disconnected extension. Check
tabs through the intended Gateway or browser node before using automation.

The target is the process host, not the computer displaying a remote dashboard.
A TUI reached through SSH runs setup on that SSH host. A loopback URL can be an
SSH tunnel and is not proof that a Gateway and Chrome share a machine. Native
setup does not silently retarget to the currently displayed Gateway. A web-only
dashboard offers Store and setup-guide links rather than installing on the viewer.

## Use it

Select the built-in `chrome` profile, or make it the default:

```bash
openclaw config set browser.defaultProfile chrome
```

```json5
{
  browser: {
    profiles: {
      chrome: { driver: "extension" },
    },
  },
}
```

Fresh automatic pairings use **All tabs**. Existing valid pairings are never
overwritten, and older pairings keep their stored access mode.

For fresh local setup, native bootstrap connects the extension through the local
Gateway's exact `/browser/extension` route. That first authenticated connection
wakes the lazy browser-control service and starts the profile's loopback relay.
OpenClaw and local clients such as mcporter then use that profile relay port.
Keep `openclaw gateway run` or the managed Gateway service running. A separate
browser request or prewarm step is not required.

Browser-node setup remains different: the extension connects to the relay on
the browser-node host while the node uses its configured remote Gateway. An
explicit `--gateway-url` pairing connects directly to that remote Gateway and
remains a manual-only flow.

### Standalone direct-loopback relay

A pairing on `ws://127.0.0.1:<port>/extension` can run without a local Gateway
or browser node. On macOS and Linux, the bundled extension can ask the installed
native host to start a standalone relay when reconnecting to that endpoint.
Automatic setup must be enabled. Requests are limited to once per minute.
The extension still authenticates the relay with connection-bound v2 proofs.
This requires both the updated native host and an extension build containing
relay wake-up support. Store publication can lag the bundled extension. The
bundled unpacked development copy is the source-build validation path.

Automatic wake-up requires the exact `127.0.0.1` host that the daemon serves.
Other loopback aliases, including `localhost` and IPv6, do not trigger wake-up.
Use the canonical IPv4 endpoint when pairing for standalone operation.

Wake-up uses the port in the extension's existing canonical pairing. It does
not switch to the first configured profile. The native host resolves current
[`browser.profiles`](/gateway/config-browser-ui-desktop#browser) and permits
only an extension-driver relay port, including
automatically allocated ports and explicit `cdpPort` pins. A removed profile
or stale port fails closed. Correct the pairing to match the current profile.
Gateway `/browser/extension` routes and remote pairings never trigger local
daemon wake-up. Browser-node pairings that use a direct loopback relay can use
it even when their Gateway hint points to a remote host.

An existing listener keeps ownership of its port. Otherwise, the native host
spawns `dist/extensions/browser/relay-daemon-entry.js` as a detached process.
The daemon uses the same per-host relay key and stays alive while an extension
or CDP client is connected. After both disconnect, it exits following ten
minutes of inactivity, checked every 30 seconds. Closing Chrome alone does not
stop it while a CDP client remains connected. A later reconnect can wake it again.

The standalone daemon defaults to **v2-only authentication**, independently of
the Gateway relay's legacy default. Only an explicit
[`browser.extensionRelay.allowLegacyAuth=true`](/gateway/config-browser-ui-desktop#browser)
enables legacy authentication.
An unset value, `false`, or a config-read failure never enables it. Prefer v2
clients so the persistent key is not disclosed to a process occupying the port.

Gateway browser control can join a standalone relay that already owns the
configured profile and port. It authenticates that exact owner with v2 and uses
its existing bridge. It does not start a second listener. Stopping Gateway
releases only Gateway's connections, leaving the daemon, its direct extension
connection, and other CDP clients running. Gateway-first automatic setup through
`/browser/extension` remains supported.

Both the daemon and the Gateway must run builds that implement the owner-access
protocol. Mixing versions is unsupported. A
mismatched profile, port, key, or stricter authentication policy produces an
error. Gateway never takes over the listener or falls back to legacy credentials.
The daemon's stricter v2-only default is compatible with Gateway's default.

### Choose tab access

- **All tabs** exposes every eligible ordinary tab in that Chrome profile,
  except tabs paused for the current browser session. Use **Pause on this tab**
  and **Allow on this tab** in the popup.
- **Selected tabs** uses the **OpenClaw** tab group as the access-control
  boundary. Moving a tab into the group grants access. Moving it out revokes
  access.

Open the extension's Settings page to change the access mode. Switching to
Selected tabs immediately detaches ungrouped tabs, including attaches already
in flight. Agent-created tabs stay in the OpenClaw group in either mode.

The extension excludes incognito tabs, internal pages such as `chrome://` and
`chrome-extension://`, and tabs without a usable current URL. `file://` access
also requires Chrome's **Allow access to file URLs** setting.

An agent-created tab may start at `about:blank` while a CDP client initializes
it before navigating. The extension allows that specific initial tab, keeps it
in the OpenClaw group, and applies the same pause and access-mode controls.
Normal navigation keeps the tab available in either access mode.
Existing blank tabs, manually grouped blanks, and other `about:` pages remain
unavailable. Navigating away, replacing the tab, or restarting or reconnecting
the extension ends the initial blank admission. Returning to `about:blank`
does not restore it.

If creation fails before the extension returns the target, it attempts to close
the tab only while it still owns it. Tabs you paused, moved, or navigated during
creation are left alone. A redirect, lost connection, or worker shutdown can
leave a tab behind. Close it manually if needed.

An explicitly commanded main-frame navigation of an authorized tab can also
use exact `about:blank`, for example during a performance trace reset. Chrome
must confirm the root frame and loader on the same attachment. An iframe
navigation or a blank URL alone does not grant access.

That temporary admission ends on the next nonblank document, debugger detach,
access-mode change, pause, group or window change, tab closure or replacement,
reconnect, or extension restart. Failed navigation never closes an existing
tab or restores a URL over your navigation.

## Automatic setup controls

Settings shows redacted relay/native bootstrap status and the **Use automatic
local setup** switch.

- Turning automatic setup off preserves a valid existing pairing but prevents
  new native bootstrap and standalone relay wake-up attempts.
- **Disconnect and disable automatic setup** revokes the pairing immediately,
  detaches debugger sessions, and persists the opt-out.
- **Use local OpenClaw** clears the opt-out and retries the native host.
- Saving an explicit manual pairing also clears the opt-out.

Pre-release development installs that paired before local Gateway wakeup
routing keep their existing pairing unchanged. In Settings, use **Disconnect
and disable automatic setup**, then **Use local OpenClaw** to create the new
local pairing. Released builds do not require this recovery step.

### Upgrades from the retired tab copilot

If Settings says automation is paused to protect a pre-upgrade copilot
session, confirm that old runs are finished. Then click **Disconnect and
disable automatic setup** to discard the retired recovery state, followed by
**Use local OpenClaw** to reconnect. Until that explicit disconnect succeeds,
the extension preserves the retired state and blocks relay connections, native
setup, manual pairing, tab access changes, and debugger attachment.

Chromium caches the first missing-native-host result for the running browser
process. If an existing extension already attempted automatic setup before the
native host was installed, restart Chrome once (a full browser-process reload).
Retrying from the popup or Settings cannot clear that process-level miss.
Normal setup avoids it by pre-registering the host before adding or reopening
the Store extension. For development, pre-register before **Load unpacked**.

## Status and removal

Inspect the installation without printing credentials:

```bash
openclaw browser extension status
openclaw browser extension status --json
```

JSON `storeInstallRequests` entries report `requested` for a verified
OpenClaw-owned request, `missing` when no request exists, `foreign` for an
unrecognized registration, or `invalid` when the file cannot be safely read or
validated. `storeDiscovered` reports `enabled` and `awaitingApproval` separately.
A requested installation, a discovered extension, or an enabled extension does
not prove an authenticated relay connection.

An `owned` native-host registration is not necessarily launchable. Status reports a filesystem
readiness snapshot of its registered runtime and native entry. It does not execute
either target or verify that its code will run successfully. If an upgrade removes
either target, rerun `openclaw browser extension install` to repair the owned
registration. Ownership checks still refuse foreign or malformed manifests and
launchers.

Managed deployment owners can inspect registered entrypoints without reading
Chrome profiles or Store requests:

```bash
openclaw browser extension repair --dry-run --json
```

The report includes `retainedNativeHostPaths` and `retentionSafe`. Keep referenced
package releases until their registrations move. If inspection is incomplete
(`retentionSafe: false`), leave releases in place and report the warning; this
must not turn a browser repair failure into a Gateway update failure.

To refresh only registrations belonging to one retired package, run the command
from its replacement installation with the exact old entrypoint:

```bash
openclaw browser extension repair --from /path/to/old/package/dist/extensions/browser/native-host-entry.js --json
```

Repair keeps unrelated installations, missing registrations, the stable extension
copy, browser profiles, Store requests, and pairing credentials unchanged. It
retains the launcher's saved state and configuration selection even when the
repair command runs with different environment settings. It
uses the same ownership and origin checks as explicit installation. It does not
restart Chrome or prove a relay connection. Replacement launchers are immutable;
the native manifest switches only after its launcher is complete, so a failed
manifest write leaves the prior registration available for retry. General Doctor still skips personal
browser profile discovery; use `extension install` for first-time setup.

Remove only OpenClaw's macOS Chrome Store installation request:

```bash
openclaw browser extension uninstall-store
```

Chrome may remove an externally installed extension on its next startup after
the request is removed. This command leaves native-host registration and the
development copy intact, and refuses foreign or malformed request files.

Remove only OpenClaw-owned native-host manifests and launchers:

```bash
openclaw browser extension uninstall-host
```

This does not remove the Store or unpacked extension from Chrome. Use
`chrome://extensions` for that. It also does not delete the stable development
copy or an existing relay key.

`openclaw browser extension path` is read-only. It prints the stable installed
copy when present and the bundled source directory otherwise.

## Advanced manual pairing

The Settings page owns manual pairing. Generate a host-local pairing string:

```bash
openclaw browser extension pair
```

Manual pairing remains useful for unsupported topologies and recovery. Treat the complete
pairing string as a password.

Without `--gateway-url` or `--local-gateway`, this command retains the host-local `/extension` relay
for standalone manual pairing. It does not wake Browser control. With native
wake-up support installed and automatic setup enabled, the extension can
start that relay on reconnect without a local Gateway. Otherwise, the relay
must already be running, for example through Browser control or a browser node.

Desktop native helpers can use `openclaw browser extension pair --local-gateway --json`
to obtain the same local Gateway wake-up route as automatic native bootstrap.
This requires a local Gateway configuration, rejects `--gateway-url`, and keeps
ordinary manual pairing unchanged. Its output contains the relay credential
and must not be logged.

For a laptop that has Chrome but does not run OpenClaw or a browser node, pair
directly to a remote Gateway:

```bash
openclaw browser extension pair \
  --gateway-url wss://gateway.example.com
```

Paste that string in **Settings → Advanced manual pairing**. This flow cannot
use native bootstrap: the remote Gateway owns a different relay key, and the
local native host never fetches or copies it. Non-loopback remote URLs require
`wss://`, and the Gateway must expose the exact `/browser/extension` WebSocket
path without a path-rewriting proxy prefix.

## External CDP clients

The relay supports Browser Relay Authentication v2 clients such as mcporter.
OpenClaw and an external client can stay connected together. When a client
enables Runtime, the extension checks current tab access before the relay
replays existing execution contexts to that new subscriber. This does not
reset another client's Runtime session.

Runtime binding callbacks go only to logical sessions that successfully registered
the binding name, independently of `Runtime.enable` and `Runtime.disable`.
Removing a binding or disconnecting a client preserves other clients' registrations
of the same name. Context-specific registrations with the same name still share
the underlying native Runtime. Use distinct names when clients need separate
context selection.

Fetch request interception has one owner per native target session. Another
client can use other CDP domains, but cannot replace that owner's interception
settings or resolve its paused requests. Competing interception requests return
an error rather than silently changing the active owner's policy. Fetch response
streams also belong to the logical session that acquired them.

Related targets (such as frames and workers) have separate logical sessions
for each interested parent. Each parent's ordered auto-attach filter is
preserved. The native attachment uses their union. New or broadened interests
receive existing children only after the extension accepts the command. The
native pause-on-attach setting remains shared: the latest update wins,
including DevTools suspend/resume. Resuming a waiting target affects all its
logical sessions.

Clients still share the underlying tabs. Navigation or page changes can
invalidate another client's snapshot refs. This is not an isolated browser per
client or complete isolation of every CDP domain and competing client policy.
A complete tab-list request returns an error when native targets cannot yet be
matched to Playwright pages, rather than reporting a partial list as complete.
Pages that Chrome permanently refuses to debug, such as the Chrome Web Store,
are excluded from this list. The Gateway logs a warning naming the skipped tab
and Chrome's refusal; ordinary tabs remain available. Transient attachment
failures still fail the complete request. This handling is Gateway-side and
does not require a new Chrome extension release.

If the extension connection drops, its debugger attachments retire before the
replacement connection reattaches. An uncertain native Fetch operation also
retires the affected attachment instead of retrying the operation against a
replacement. Fetch cleanup is bounded. Debugger teardown is not a guarantee that
pending network requests are canceled. These paths do not change the access
mode or paused tabs. Take a fresh snapshot after the target reattaches before
using element refs. If a client no longer exposes the target, reconnect that
client.

If Chrome closes a native target while its tab remains accessible, the relay
restores automatic attachments for clients that still subscribe to that tab.
It rechecks current access and gives clients a fresh session; it never replays
the failed command. Explicit client detach and Chrome's debugger Cancel action
remain effective. Take a fresh snapshot before continuing after recovery.

If native detach fails, the error is reported and cleanup debt stays with that
exact attachment. Other tabs remain usable, but the affected tab cannot acquire
a replacement until cleanup succeeds. After restoring Chrome access, retry an
explicit attachment or **Disconnect**. Chrome's debugger Cancel action can also
end the native attachment. Removing or replacing a tab alone is not treated as
proof that its debugger client closed. Failed CDP operations are never retried
against a replacement session.

The connection-lifetime protections require updated extension code as well as
an updated OpenClaw installation. Update the Store extension when available.
For an unpacked development copy, rerun `openclaw browser extension install`
and reload the installed copy from `chrome://extensions`.

Print non-secret endpoint metadata:

```bash
openclaw browser extension cdp
openclaw browser extension cdp --json
```

The output includes the loopback endpoint, protocol version, key ID, and fixed
challenge/complete resources. It does not include the relay key or an
authorization header.

`cdp --legacy-bearer` is a warned compatibility escape hatch for clients that
cannot use Browser Relay Authentication v2. It
works only while `browser.extensionRelay.allowLegacyAuth=true` and prints the
legacy credential on request.

## Permissions

The extension requests only:

- `debugger`: send CDP commands to allowed tabs.
- `tabs` and `tabGroups`: discover tabs and enforce access mode.
- `storage`: persist pairing, access mode, session pauses, and bootstrap opt-out.
- `alarms`: wake the MV3 worker for relay/bootstrap retries.
- `nativeMessaging`: request a local bootstrap pairing or wake its configured relay.

It does not request `activeTab`, `contextMenus`, `scripting`, or `sidePanel`.

## Native bootstrap security

The native host is `ai.openclaw.browser_bootstrap`. The extension opens a
`chrome.runtime.connectNative` port for one request, validates the response,
then disconnects. The host writes one response and exits. A spawned standalone
relay outlives this short-lived native connection.

The request uses a versioned, length-prefixed JSON frame with a fresh 16-byte
nonce. The host caps input at 4 KiB, requires fatal UTF-8 decoding and exact
fields, verifies the caller origin against the exact installed manifest, and
returns only a locally generated pairing, a relay status, or a bounded
non-secret failure code. The bootstrap request remains exactly
`{v:1, op:"bootstrap", nonce}`. Relay wake-up uses
`{v:1, op:"ensure_relay", nonce, relayPort}` with a required integer port from
1 through 65535. Missing, duplicate, malformed, or extra fields are rejected.
After manifest and caller validation, the host checks the requested port
against current extension profiles before probing or spawning. No request can
supply a host, executable path, or credential to the launcher.
The response is below Chrome's 1 MiB native-message limit. Pairing keys never
appear in launcher arguments, manifests, status JSON, or diagnostics.

The POSIX launcher and manifest use absolute canonical paths under an
OpenClaw-owned mode-`0700` directory. Manifests are mode `0600`. The launcher is
owner-executable. Symlinks, foreign ownership, unsafe modes, path traversal,
wildcard origins, and foreign same-name registrations fail closed.

The managed manifest authorizes the exact Foundation Chrome Web Store origin
plus deterministic development origins in canonical order. The Store identity
is a fixed product trust grant, not proof that an arbitrary path is
OpenClaw-owned.

Install the official Chrome Web Store build for normal use. Only load unpacked
development copies you trust: Chrome can give a key-matched unpacked build the
same extension identity and native-host access.

The unpacked development ID calculation matches Chromium's
`crx_file::id_util::GenerateIdForPath`: hash the canonical absolute path's raw
bytes with SHA-256 (native UTF-16LE path bytes on Windows, with only a lowercase
drive letter uppercased), keep the first 16 digest bytes, then map hexadecimal
digits `0` through `f` to letters `a` through `p`. The unpacked extension
manifest has no `key`. Only these development IDs depend on approved
OpenClaw-owned realpaths.

The relay itself uses connection-bound HMAC proofs. The persistent per-host key
is not sent in a URL, header, WebSocket subprotocol, or application frame during
v2 authentication. On POSIX hosts, each key read rejects foreign-owned and
non-regular files and tightens an owned group/other-accessible file to `0600`.
If tightening fails, the key is refused. Windows uses its existing ACL policy.

## Troubleshooting

```bash
openclaw browser extension status --json
openclaw browser doctor --browser-profile chrome
openclaw doctor
```

- **No native host was pre-registered:** check the preceding per-browser refusal
  diagnostics and resolve the reported path, ownership, or permission issue. This
  summary does not mean that Chrome's user-data directory is missing. If Chrome
  has never been launched, launch it first, then rerun `extension install` before
  adding the extension.
- **No extension ID detected:** keep Chrome running, rerun `extension install`,
  then add the official Store extension. Use **Load unpacked** only as a
  development fallback after the command says native bootstrap is ready.
- **Extension was loaded before native bootstrap:** restart Chrome once to clear its
  cached native-host miss, then rerun the ordered install flow.
- **Extension version mismatch:** reload the unpacked OpenClaw extension from
  `chrome://extensions`, then rerun browser doctor. Fully restart Chrome if the
  running and bundled versions still differ.
- **Waiting for local OpenClaw:** run `extension status`. Install or repair the
  owned native host.
- **Automatic setup disabled:** enable it in Settings or click **Use local
  OpenClaw**.
- **Manual setup required:** use Settings for the advanced pairing flow. This
  is expected for direct extension-only remote Gateway setups. On Windows, first
  check that the packaged native executable and matching local CLI are installed
  and that their private ACL/context checks succeed.
- **Relay unavailable:** for `/browser/extension` pairings, confirm the target
  Gateway is running. For direct loopback `/extension` pairings, check native
  host registration, wake-up support in the extension build, automatic setup,
  and that the paired port still belongs to an extension profile. Allow for the
  one-minute wake-up throttle, then run browser doctor. No local Gateway is
  required for the standalone path.

See [Browser](/tools/browser) for the full profile model and the managed
`openclaw` and Chrome MCP `user` profiles.
