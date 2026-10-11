---
summary: "Bundled Gateway runtime, app hosting, and background services on macOS"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

OpenClaw.app bundles a private runtime built from the OpenClaw Bun fork, a signed
SQLite library with extension loading, and the full matching OpenClaw package
(CLI, Gateway, and Control UI). Its app-owned `node worker` helper and fixed local
Chrome-extension setup entry point run on this Bun runtime. The app bundle
contains no Node executable.

The payload lives in one `Contents/Resources/runtime` directory. Universal apps
share the JavaScript package between architectures and include universal Bun and
SQLite binaries plus each architecture's native dependencies. Rebuilding or
replacing the app replaces this runtime too, including rebuilds with the same
public version. The app validates the package's version, commit, build time, and
build ID before launch. Moving the app or removing its build checkout does not
change which runtime it uses.

On a fresh profile, the **app hosts the Gateway** as a child process using its
bundled Bun runtime. The Gateway starts with the app and stops when the app
quits. An existing Gateway on the configured port is attached instead of
duplicated. Existing independently managed installations keep their current
lifecycle. Eligible app-managed Node services move to bundled Bun while keeping
their always-on service.

Before launching an app-hosted Gateway, the app saves a local authentication
token when neither configuration nor the child environment supplies credentials
and token authentication is selected or implicit. Existing credentials, secret
references, and other authentication modes are preserved. If the token cannot
be saved, setup stops with a retryable error. This also applies to a local
Gateway hosted alongside a remote primary connection.

The app first copies its runtime to `<state>/runtime/<runtimeBuildId>/`, where
`<state>` is `~/.openclaw` or `~/.openclaw-<profile>`. Copies use one APFS
directory clone when available, falling back to a file copy, and are published atomically after provenance and
Bun checks succeed. The child and app-managed Bun service use the concrete
build directory so each process keeps its matching package and SQLite library.
The `runtime/current` symlink selects the runtime for the terminal CLI shim.
The app retains the current and previous builds; older copies are removed only
after Gateway health succeeds and no process runs from them.

For an app-owned full Gateway payload, packaging writes
`openclaw-install-owner.json` at the OpenClaw package root with `schemaVersion: 1`,
`owner: "macos-app"`, `displayName: "OpenClaw.app"`, and
`updateHint: "Update OpenClaw.app to update this Gateway."`. This contract keeps
payload and runtime updates with the app updater (Sparkle): core reports the
owner, skips package-registry update checks, and refuses self-update and runtime
migration. A launching host can set `OPENCLAW_GATEWAY_HOST_LIFELINE=stdin` and
retain the stdin pipe writer; EOF or a pipe error requests graceful Gateway
shutdown. App-hosted Gateways use this lifeline so they exit even if the app
ends unexpectedly.

The private worker validates core and node configuration through a read-only
bootstrap, without Gateway-wide Doctor preflight or channel-schema validation.
Node plugins still validate their own settings before publishing commands, and
the node runtime owns its MCP clients. Node startup retains the Doctor-owned
device-auth, device-identity, and exec-approval migrations; this is not a promise
that all worker startup is read-only. Public `node run`, Gateway, and Doctor
retain their existing startup policies.

When the native app creates identity, device-auth, or approval tables before
the worker starts, node startup completes that recognized version-zero database
through the shared initializer before plugins read their state. Existing
native rows are preserved. This does not migrate an already-versioned shared
Gateway database or adopt unknown or occupied bootstrap state.

## Automatic setup

On a fresh Mac, choose **This Mac** during onboarding. **Getting things ready**
prepares the included runtime, starts the Gateway, and verifies that it is
ready. This setup needs no runtime download, Node installation, Terminal,
Homebrew, or administrator access. Connecting an AI provider can still require
internet access.

The app creates `<state>/bin/openclaw`, a small shell wrapper that runs the
current bundled CLI with Bun and the included SQLite library. It also links
`openclaw-mac` beside it and adds that bin directory to the usual shell profile
files. An existing operator-created `openclaw` file is preserved; only the
app's own wrapper or a recognized `install-cli.sh` wrapper is replaced.

Unbundled DEBUG builds retain the developer installer and channel chooser.
That installer uses a private temporary directory for downloads and build tools,
falling back to a private directory under `/tmp` when the inherited temporary
directory is inaccessible.

Remote connections and attachment to an independently managed local Gateway
skip this installation. Attach-only mode never prompts for a CLI to run the
app's node. Pausing preserves who manages the Gateway, even when stopping an
app-managed service removes its LaunchAgent record. If an independent endpoint
is no longer available on reattachment, local setup becomes available again.
An unreadable service ownership record blocks automatic installation instead
of being treated as a missing service; check the LaunchAgent and retry.

Chrome-extension preparation also runs automatically for the default app
profile, including remote-only and attach-only Macs. It uses the validated
private runtime, registers the native helper before requesting the Store
extension, and leaves Chrome’s permission approval to you. Browser setup does not
run Gateway-wide Doctor or migrate Gateway state. The Dashboard’s **Set up Chrome
on this device** action retries the same serialized operation. See
[Chrome extension](/tools/chrome-extension).

## Manual recovery

Read the version to install from the app: choose **About OpenClaw** in the
menu bar, or run `openclaw-mac status --json`, which reports the app version
and build.

For a manual install, use Node 26 (recommended) or another supported release:
Node 24.16+ or Node 26.1+. Install `openclaw` globally:

The command below is for npm 12 or npm 11.16+. On npm 11.15 and earlier,
omit `--allow-scripts=openclaw`.

```bash
npm install -g openclaw@<version> --allow-scripts=openclaw
```

Use **Retry setup** after a failed bundled setup. If the runtime payload is
missing or incompatible, reinstall OpenClaw.app. Installing a global CLI does
not repair the app's bundled payload. The manual Node installation above is for
an independently managed Gateway or unbundled development setup.

For an existing app-managed Gateway using the app's exact-version policy,
**Retry setup** updates an older package through its installed CLI before starting
it. Failed updates remain retryable; channel policies and operator runtime pins
keep their existing update path.

## Launchd (Gateway as LaunchAgent)

Label: `ai.openclaw.gateway` (default profile), or `ai.openclaw.<profile>`
for a named profile.

Plist location (per-user): `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
(or `ai.openclaw.<profile>.plist`).

The macOS app can manage the Gateway as a background service instead of a
child process. Turn on **Keep OpenClaw running when the app is closed** next to
**Launch at login** in Dashboard device settings, or during bundled onboarding.
It is off for fresh setups. Enabling it stops the child and starts the background
service; disabling it removes the service and starts an app-owned child. The
control is unavailable for independently managed Gateways and connections that
do not host a local Gateway. A paused Gateway stays paused when this preference
changes.

If the replacement Gateway fails to start, the app restores the previous hosting
mode and verifies its health before reporting the failure. An operator change to
the service, or pausing or quitting during the switch, stops automatic recovery;
the app preserves the newer choice and reports what could not finish.

The app preserves settings from the Gateway's generated service environment and
rereads that file on later app launches. If a service has settings that would be
lost after switching to app hosting, the app leaves the service unchanged and
asks you to move the needed settings into the profile's persistent configuration
or `.env` file. Run `openclaw gateway install --force`, then retry the hosting
change. This uses the Gateway CLI's existing persistence rules for
provider credentials and referenced configuration; arbitrary ambient variables
are not guaranteed to persist through a new service installation.

The CLI can also install it directly: `openclaw gateway install`
(named profiles are selected via the `OPENCLAW_PROFILE` env var).
Enabling an existing service from the app preserves its saved runtime pin.
If the pin is invalid, enabling fails with the CLI error; reinstall explicitly with
`--runtime` or `--runtime-path` to replace the saved pin.
Disabling it uninstalls the LaunchAgent, which removes the pin.

A newly installed app-managed Bun service is pinned to
`<state>/runtime/<runtimeBuildId>/bin/bun`, with the matching package and
`OPENCLAW_SQLITE_LIBRARY` environment. After an app update, the app reinstalls
only services it owns whose executable is inside `<state>/runtime/` onto the new
concrete build. A service using an executable outside that directory stays
unchanged, including an unpinned executable. The update window reports
"Gateway service uses an operator-pinned runtime; update it yourself."

Behavior:

- In service mode, "OpenClaw Active" enables/disables the LaunchAgent.
- In service mode, quitting the app does **not** stop the Gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.
- Other listeners are left running. Resolve port conflicts through the process
  or service that owns them; automatic cleanup only reaps recorded orphaned SSH tunnels.
- If service inspection is inconclusive, the app defers installation and uses
  its existing readiness checks. A service confirmed absent can still be installed.

Use the CLI for lifecycle checks and recovery:

```bash
openclaw gateway status --deep
openclaw gateway restart
```

When **Also run a Gateway on this Mac** is enabled with a remote primary, the
managed launch agent includes `--allow-unconfigured` so it can run while
`gateway.mode` remains `remote`. Switching the primary to local removes that
argument. See [local hosting alongside a remote primary](/platforms/mac/remote#run-a-local-gateway-alongside-a-remote-primary).

Launchd provides auto-start at login, crash restarts, and one predictable log
location without tying the Gateway lifetime to the app process.

### Unexpected repeated restarts

Run these commands if the Gateway repeatedly restarts after an update:

```bash
openclaw gateway status
openclaw doctor
```

On macOS, both commands report foreign loaded jobs in the `ai.openclaw.*`
namespace, including jobs submitted without a plist. The report shows each
label, program, KeepAlive flag, and detected `openclaw gateway restart`,
`start`, or `stop` invocation. Plain-text status shows the list as a warning when
at least one job has KeepAlive or a verified lifecycle invocation. Otherwise,
the list appears informationally under "Other OpenClaw launchd jobs (macOS)".
Status JSON includes all these jobs under
`service.foreignLaunchdJobs`. For warnings, recent external forced restarts in
the lifecycle log provide a possible correlation; the count alone does not
identify which job caused a restart.
After three external forced restarts within ten minutes, the managed Gateway
logs an actionable warning naming likely KeepAlive jobs when available. It
does not suppress an operator's restart command.

To remove confirmed stray Gateway lifecycle jobs and verify recovery:

```bash
openclaw doctor --fix
openclaw gateway status
openclaw health
```

Doctor removes a foreign job only when its literal, straight-line script or
direct arguments invoke an absolute OpenClaw path with a Gateway lifecycle
subcommand. Shell jobs must also have no launchd environment entries that alter
shell execution. Everything outside this contract is reported and left unchanged.
This is command-metadata verification; it does not check binary executability,
interpreter availability, or quarantine state.

Doctor preserves managed LaunchAgents, unrelated labels,
and jobs whose purpose cannot be established, and names every removal even
in noninteractive runs. Service repair remains disabled for an isolated install
identity, external supervision, or an update in progress.

Never use `launchctl submit` or an ad-hoc KeepAlive job for updates or Gateway
lifecycle commands. Such a job can repeatedly run `openclaw gateway restart`
whenever its script exits, as described in
[#114967](https://github.com/openclaw/openclaw/issues/114967). Use the managed
update workflow and its suspension fence, then verify status and health.

### Attach-only development

When another process already owns the local Gateway, run the development app
without installing or changing its LaunchAgent:

```bash
scripts/restart-mac.sh --attach-only
```

Launching the app directly with `--attach-only` or `--no-launchd` has the same
effect. The override persists in `~/.openclaw/disable-launchagent`; remove that
file to restore app-managed launchd behavior.

Named profiles still require the listener to belong to that profile's Gateway
service. Attach-only mode does not permit attaching another process or profile.
If a port ownership conflict occurs, automatic recovery preserves the failure
instead of repeatedly reopening the dashboard. Resolve the conflict, then
relaunch the app.

Logging:

- Gateway stdout: `~/Library/Logs/openclaw/gateway.log` (profiles use
  `gateway-<profile>.log`)
- Gateway stderr: merged into the same `gateway.log` file, so startup failures
  that happen before the logger starts are still recorded
- If the host loops with repeated `EADDRINUSE` or fast restarts, check for
  duplicate `ai.openclaw.gateway` / `ai.openclaw.node` LaunchAgents and the
  launchd-marker workaround in
  [Gateway troubleshooting](/gateway/troubleshooting#macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents).

## App-hosted lifecycle and updates

During local startup, readiness probes own the retry cadence and deadline.
Connection refusals while the Gateway boots do not leave an exponential
connection delay that holds up a ready Gateway.

The app restarts a crashed child with a delay that doubles from one second to
30 seconds, resetting after 60 healthy seconds. Five rapid failures stop the
restart loop and show the failure with the Gateway log tail. Pausing or quitting
closes the host lifeline and waits for graceful shutdown before forcing an
unresponsive process group to exit.

After an app update, including a rebuild with the same public version, the app
seeds the new runtime and restarts its Gateway in the selected hosting mode.
It verifies health before removing old builds. A paused Gateway stays paused.
Seeded installations never run npm self-update; update OpenClaw.app to update
their Gateway. A paused legacy app-managed Node installation keeps background-service
hosting even when the old app removed its LaunchAgent. While paused, the app records
that preference without checking or changing the runtime. On resume it recovers the
managed Node CLI before updating; this also applies to named profiles. Existing
app-managed Node services continue through their installed CLI's update and repair flow, including health verification, and keep their runtime
pin. A seed left on disk does not adopt an attached Node service. If that legacy
runtime cannot be verified, the update window keeps the failure retryable instead
of replacing it with a fresh bundled installation. A missing `runtime/current`
link is repaired by seeding; old builds stay until a later successful update
reestablishes the previous-build record. Invalid existing metadata remains a
retryable failure. External services and channel policies keep their existing
ownership rules. With a remote primary, an installed legacy Mac node service is
updated and verified through its own captured CLI. The app-owned local companion
Gateway is then updated separately; the update receipt stays pending until both
required runtimes are healthy. The bundled private worker is not a Node LaunchAgent,
and absent node services or named profiles do not trigger legacy node lifecycle work.

To install a local rebuild over a release app, package it with the release
identity. A default debug package keeps separate permissions, default-profile
preferences, and saved Gateway profiles, and raises login-keychain prompts for
the release app's Keychain items. See
[Replace an installed release app](/platforms/mac/dev-setup#replace-an-installed-release-app).

### Existing app-managed Node services

For the default profile after onboarding, the app migrates its exact-version
Node installation in two separate attempts. If the installed version differs
from the bundled version, the existing managed updater first updates the Node
installation to the app's version. The core updater owns backups, rollback, and
database migrations. A failed update leaves the runtime on Node and shows the
existing update failure and Retry window.

On the next launch or Retry, once the core update or repair completes and the
versions match, the app seeds its bundled runtime and reinstalls the service with matching concrete Bun, package, and
SQLite paths. It verifies health before completing the migration. If that step
fails, it reinstalls and verifies the retained same-version Node command, then
shows the failure with Retry. The app retains the old Node tools and npm package
for recovery. Pausing and relaunching before migration finishes preserves the
Node resume path; it does not skip the version update or enable the hosting
toggle early.

Before an app-owned install through the bundled CLI, the app reads runtime intent
with that same CLI, runtime, and environment using `gateway status --deep --json`.
It passes the observed revision and service definition to the installer after its
final local custody checks. Failed or unknown inspection stops the install. If an
operator changes the service or runtime pin before installation begins, the CLI
preserves that selection and the app reports it without retrying or rolling it
back.

Node rollback and prior-build restoration use this app's bundled CLI with the
same runtime-intent observation. The installer restores the retained package's
runtime and entrypoint, and its SQLite library for Bun, rather than its own.
Recovery does not require the failed replacement service to be running. An
operator change is preserved and reported without retry. If the app's bundled
runtime is missing or incompatible, recovery stops; reinstall OpenClaw.app.
The core updater step still runs the installed CLI and is not covered by this
installation fence.

Channel-policy installs, independently managed services, and services with
saved operator runtime pins are not migrated. This includes a saved pin pointing
at the app's Node tools. This registered-service migration does not run
automatically in named profiles.

Older apps removed the LaunchAgent when paused. After onboarding in local mode,
the surviving app-managed Node installation preserves service hosting even when
the LaunchAgent is absent. This applies to default and named profiles using an
exact or unset install policy. While paused, the app only records the hosting
preference; it does not update, seed, or install a Gateway.

On Resume, the app uses that Node installation's core updater to reach the app's
version without restarting a service. It then seeds Bun, installs the service,
and verifies health in the same startup attempt. If the runtime switch fails,
the app reinstalls and verifies the same-version Node service and shows the
update failure with Retry. Fresh profiles retain app hosting; channel policies,
attach-only profiles, and independently managed installations are not adopted.

## Version compatibility

The private worker must match the app's build provenance, not merely its
version number. A missing or incompatible worker payload produces a visible
worker error; rebuild or reinstall the app. Changing CLI channels or updating
a global CLI does not repair this private payload. Unbundled Swift development
builds can use the checkout's freshness-aware source runner instead.

If a Gateway update advances the shared state database schema beyond the private
worker's supported version, update and relaunch OpenClaw.app too. Restarting the
external Gateway does not replace the app-owned worker. A schema-version error
from that older reader does not mean the upgraded Gateway's database is corrupt.

For a bundled local Gateway, the app validates the seeded runtime against its
own build provenance; Node version requirements do not gate setup. Unbundled
development builds check the external CLI against their install policy. An
attached Gateway uses connection and health checks instead of local CLI
installation diagnostics. Use **Retry setup** after failed setup, or open
**Connection… → Connection** from the menu bar and choose
**Recheck** after repairing it. The Connection window remains available when
the Dashboard cannot reach the Gateway.

## State directory on macOS

Keep OpenClaw state on a local, non-synced disk. Avoid iCloud Drive and other
cloud-synced folders; sync latency and file locks can affect sessions,
credentials, and Gateway state.

Set `OPENCLAW_STATE_DIR` to a local path only when you need an override.
`openclaw doctor` warns about common cloud-synced state paths and recommends
moving back to local storage. See
[environment variables](/help/environment#path-related-env-vars) and
[Doctor](/gateway/doctor).

## Debug app connectivity

Inspect the running app with the bundled macOS CLI:

```bash
openclaw-mac status --json
openclaw-mac primary show --json
openclaw-mac gateway list --json
```

The app's CLI installer links `openclaw-mac` beside its profile-managed
`openclaw` command. You can also run
`/Applications/OpenClaw.app/Contents/MacOS/openclaw-mac` directly. See
[remote control](/platforms/mac/remote#macos-app-setup) for `primary set`,
saved-Gateway commands, profiles, and credential input.

For standalone Gateway WebSocket handshake and discovery checks from a source
checkout, the existing debug commands remain available:

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

`connect` accepts `--url`, `--token`, `--timeout`, `--probe`, and `--json`
(plus client-identity overrides; run with `--help` for the full list).
`discover` accepts `--timeout`, `--json`, and `--include-local`. Compare
discovery output with `openclaw gateway discover --json` when you need to
separate CLI discovery from app-side connection issues.

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Then:

```bash
openclaw gateway call health --port 18999 --timeout 3000
```

## Related

- [macOS app](/platforms/macos)
- [Gateway runbook](/gateway)
