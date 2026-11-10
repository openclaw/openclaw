---
summary: "Run, update, and troubleshoot the Gateway included with the macOS app"
doc-schema-version: 1
read_when:
  - Running the Gateway included with OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

OpenClaw.app includes everything needed to run a Gateway on your Mac. You do
not need to install Node, Bun, or a global CLI.

On a fresh setup, the Gateway starts and stops with the app. You can also
[keep it running in the background](/platforms/mac/bundled-gateway#launchd-gateway-as-launchagent). If a Gateway
already runs on the configured port, the app connects to it instead of starting
another one. Independently managed Gateways keep their existing lifecycle.

For first-time setup, start with [Onboarding (macOS app)](/start/onboarding).
This page covers local hosting, updates, recovery, and runtime details.

## Automatic setup

On a fresh local setup with no configuration or saved connections, opening the
app shows **Setting up OpenClaw on this Mac**. The app prepares its runtime,
starts the Gateway, and opens automatic setup in the dashboard.

- Choose **Set up manually** to use native setup. Its **Getting things ready**
  page prepares the same runtime when needed.
- Existing configurations keep their connection.
- Setup needs no runtime download, Terminal, Homebrew, or administrator access.
  Connecting an AI provider may still need internet access.
- Setup waits while Gateway startup retries. If startup fails, the relevant
  native setup step opens. Failure or cancellation leaves onboarding unfinished.

See [Onboarding (macOS app)](/start/onboarding) for eligibility and fallbacks.

### Terminal commands

The app creates `<state>/bin/openclaw` to run its bundled CLI with Bun and SQLite.
By default, `<state>` is `~/.openclaw` or `~/.openclaw-<profile>`.

When the app runs from a persistent location, it also links `openclaw-mac` beside
that command. The default profile adds the bin directory to the usual shell
profile files.

Named profiles and apps running from Downloads, Desktop, a disk image, or a
temporary directory such as `/tmp` do not change shell profiles. Use the full
command path instead, for example `~/.openclaw-<profile>/bin/openclaw`.

The app preserves an operator-created `openclaw` file.

### Existing and development Gateways

Remote connections and independently managed local Gateways skip runtime
installation. Attach-only mode does not prompt for a CLI to run the app's node.

Pausing does not change who manages the Gateway, even if stopping an app-managed
service removes its LaunchAgent record. If an independent endpoint is unavailable
when reconnecting, local setup becomes available again. If the service ownership
record cannot be read, installation stops: check the LaunchAgent and retry.

Unbundled DEBUG builds use a separate installer and channel chooser. See
[macOS development setup](/platforms/mac/dev-setup).

### Set up Chrome

In the dashboard, choose **Settings → This Mac → Set up Chrome on this device**.
This also works on remote-only and attach-only Macs. Use the same action to retry.

You approve Chrome's permissions. Opening OpenClaw alone does not inspect or
change Chrome data. For setup and troubleshooting, see
[Chrome extension](/tools/chrome-extension).

## Manual recovery

Use **Retry setup** after a failed bundled setup. If the bundled runtime is
missing or incompatible, reinstall OpenClaw.app. Installing a global CLI does
not repair the app's runtime.

The app automatically restarts a crashed Gateway, including an illegal instruction
(`SIGILL`), after 1, 2, 4, then 8 seconds. It stops after five fast failures and
preserves the crash output in the Gateway log. A minute of healthy operation resets
that limit. Update or reinstall the app if failures persist, and include the log
when reporting them. The app does not automatically switch to Node.

For an app-managed Gateway with an exact-version policy, **Retry setup** updates
an older package through its installed CLI before starting it. Failed updates
can be retried. Channel policies and operator runtime pins keep their existing
update path.

### Install an independent Node Gateway

An independently managed [Node Gateway](/install/node) is an alternative to the
bundled Gateway. Connect the app to it after installation. This is also an option
for unbundled development setups.

1. Find the app version in **About OpenClaw**, or run
   `openclaw-mac status --json` to see its version and build.
2. Use Node 26.12.1+ (recommended) or Node 24.22.1+.
3. Install the matching OpenClaw version:

   ```bash
   npm install -g openclaw@<version> --allow-scripts=openclaw
   ```

   This command requires npm 12 or npm 11.16+. On npm 11.15 and earlier, omit
   `--allow-scripts=openclaw`.

## Launchd (Gateway as LaunchAgent)

The macOS app can manage the Gateway as a background service instead of a
child process. Turn on **Keep OpenClaw running when the app is closed** next to
**Launch at login** in Dashboard device settings, or during bundled onboarding.
It is off for fresh setups. Enabling it stops the child and starts the background
service; disabling it removes the service and starts an app-owned child. The
control is unavailable for independently managed Gateways and connections that
do not host a local Gateway. A paused Gateway stays paused when this preference
changes.

### Switch hosting modes

If the replacement Gateway fails to start, the app restores the previous hosting
mode and verifies its health before reporting the failure. An operator change to
the service, or pausing or quitting during the switch, stops automatic recovery;
the app preserves the newer choice and reports what could not finish.

If switching to app hosting would lose service settings, the app leaves the
service unchanged. Move the reported settings into the profile's persistent
configuration or `.env` file, run `openclaw gateway install --force`, then retry.
Do not rely on temporary shell variables surviving service reinstallation.

### Manage the service from the CLI

Label: `ai.openclaw.gateway` (default profile), or `ai.openclaw.<profile>`
for a named profile.

Plist location (per-user): `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
(or `ai.openclaw.<profile>.plist`).

The CLI can also install it directly: `openclaw gateway install`
(named profiles are selected via the `OPENCLAW_PROFILE` env var).
Enabling an existing service from the app preserves its saved runtime pin.
If the pin is invalid, enabling fails with the CLI error; reinstall explicitly with
`--runtime` or `--runtime-path` to replace the saved pin.
Disabling it uninstalls the LaunchAgent, which removes the pin.

In service mode:

- **OpenClaw Active** enables or disables the LaunchAgent.
- Quitting the app does **not** stop the Gateway; launchd keeps it alive.
- Other listeners are left running. Resolve port conflicts through the process
  or service that owns them. If the app cannot determine service ownership, it
  defers installation.

Use the CLI for lifecycle checks and recovery:

```bash
openclaw gateway status --deep
openclaw gateway restart
```

To keep a local Gateway alongside a remote primary, enable **Also run a Gateway
on this Mac**. See [local hosting alongside a remote primary](/platforms/mac/remote#run-a-local-gateway-alongside-a-remote-primary).

### Runtime pins and migration state

For bundled services, an app update replaces only app-managed runtimes under
`<state>/runtime/`. Other executables stay unchanged. If you see **Gateway service uses an
operator-pinned runtime; update it yourself**, update that installation through
its owner.

If status reports `migrationPending`, run `openclaw doctor` or complete a CLI
start/repair. The current runtime stays selected until migration completes.
For storage and migration details, see
[local service runtime state](/reference/database-schemas/layout#local-daemon-service-intent).

### Unexpected repeated restarts

Run these commands if the Gateway repeatedly restarts after an update:

```bash
openclaw gateway status
openclaw doctor
```

Look for unexpected `ai.openclaw.*` jobs, especially ones with KeepAlive or
commands that start, stop, or restart the Gateway. Status lists their labels
and programs; JSON output uses `service.foreignLaunchdJobs`. Restart warnings
can identify likely jobs, but a restart count alone does not prove the cause.

To remove confirmed stray Gateway lifecycle jobs and verify recovery:

```bash
openclaw doctor --fix
openclaw gateway status
openclaw health
```

Doctor removes only jobs it can verify as stray Gateway lifecycle commands.
It reports each removal and preserves managed LaunchAgents, unrelated jobs, and
jobs it cannot identify. Service repair is disabled during updates, under
external supervision, and for isolated install identities.

Do not use `launchctl submit` or an ad-hoc KeepAlive job to run updates or
Gateway lifecycle commands: they can create restart loops. Use the managed
update workflow, then verify status and health. See [Doctor](/gateway/doctor).

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

### Logs and installation identity

- Gateway stdout: `~/Library/Logs/openclaw/gateway.log` (profiles use
  `gateway-<profile>.log`)
- Gateway stderr: merged into the same `gateway.log` file, so startup failures
  that happen before the logger starts are still recorded
- If the host loops with repeated `EADDRINUSE` or fast restarts, check for
  duplicate `ai.openclaw.gateway` / `ai.openclaw.node` LaunchAgents and the
  launchd-marker workaround in
  [Gateway troubleshooting](/gateway/troubleshooting#macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents).

The shell CLI and running Gateway can belong to different installations even
when their versions match. Use `openclaw gateway status --deep` and
`openclaw health` to check the service command and runtime. For an app-managed
Gateway, choose **Retry** in the app. A healthy process is not enough if the app
still reports unfinished repair work.

## App-hosted lifecycle and updates

Update OpenClaw.app to update its bundled Gateway. Bundled installations do not
run npm self-update. Rebuilds with the same public version also replace the
runtime.

### Startup and crash recovery

After a child process crashes, the app retries after 1, 2, 4, and 8 seconds.
The failure count resets after 60 healthy seconds. A fifth rapid failure stops
restarts and displays the error with the Gateway log tail.

Pausing or quitting allows graceful shutdown before forcing an unresponsive
app-hosted Gateway to exit.

### What an app update does

1. Prepares the new runtime.
2. Runs Doctor for migrations and required plugin repairs.
3. Restarts the Gateway in its selected hosting mode.
4. Verifies health before removing old builds.

A paused Gateway stays paused. External services and channel policies keep their
existing ownership rules.

If required repair cannot finish, recovery stays pending. The app restores the
previous service when possible. If Doctor cleanup cannot be confirmed, the
Gateway stays stopped. Keep the reported diagnostics before retrying; plugin
warnings remain visible.

### Legacy and remote installations

Existing app-managed Node services update through their installed CLI and retain
their runtime pin. If that runtime cannot be verified, the app offers a retry
instead of replacing it with a fresh installation.

With a remote primary, a legacy Mac node service and the local companion Gateway
update separately. Both must be healthy before the update completes. The
bundled private worker is not a Node LaunchAgent.

### Replace a release app with a local build

Package the rebuild with the release identity. A default debug package has
separate permissions, default-profile preferences, and saved Gateway profiles.
It also prompts for login-keychain access to the release app's Keychain items.
See [Replace an installed release app](/platforms/mac/dev-setup#replace-an-installed-release-app).

### Existing app-managed Node services

<Accordion title="Migration steps, exclusions, and recovery">

For the default profile, migration happens after onboarding in two attempts:

1. **Update Node first.** An older installation uses its managed updater to
   reach the app's version. The core updater handles backups, rollback, and
   database migrations. Failure leaves Node in place and shows the existing
   update error and Retry window.
2. **Switch on the next launch or Retry.** Once update or repair is complete
   and versions match, the app prepares bundled Bun and reinstalls the service
   with matching Bun, package, and SQLite paths. It checks health before
   completing migration.

If the second step fails, the app reinstalls and verifies the retained
same-version Node command, then shows the error with Retry. Old Node tools and
the npm package stay available for recovery. Pausing and relaunching preserves
this Node recovery path; it does not skip the version update or enable the
hosting toggle early.

#### Checks before replacing a service

The app checks service ownership and the saved runtime choice before replacement
or rollback. Uncertain state stops installation. A runtime or service change
made by the operator is preserved and reported, not overwritten or retried.

Rollback restores the retained runtime and does not require the failed Gateway
to be running. If the app's bundled runtime is missing or incompatible,
reinstall OpenClaw.app before retrying recovery.

#### Installations that stay on their current runtime

Automatic registered-service migration excludes:

- Channel-policy installations.
- Independently managed services.
- Services with operator runtime pins, including pins to the app's Node tools.
- Named profiles.

#### Resume a paused legacy installation

A paused legacy Node installation keeps background-service hosting even if an
older app removed its LaunchAgent. This applies to default and named profiles
with an exact or unset install policy. Pausing does not install or update a
runtime.

On **Resume**, an older installation updates to the app's version, then switches
to Bun and verifies health in the same attempt. If the switch fails, the app
restores the same-version Node service and offers Retry. Fresh profiles keep
app hosting. Attach-only, channel-policy, and independently managed installations
are not adopted.

A compatible newer Node installation resumes without being downgraded or
switched to an older bundled runtime. Recovery completes only after health
checks and required migrations finish.

</Accordion>

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

For a bundled app, Connection reports the connected local Gateway's version,
or the installed service's version when disconnected—not just the app's bundled
version. An older Gateway exposes **Update Gateway…**; unfinished preparation or
recovery exposes **Repair Gateway…**, including when the Gateway is newer than
the app. A healthy compatible newer Gateway does not offer a downgrade.

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

## Runtime and credential details

The app includes matching Bun, SQLite, CLI, Gateway, and Control UI components.
Its private worker uses that runtime too. Update the app to replace these
components; changing a global CLI does not update them.

For troubleshooting, runtime builds live under
`<state>/runtime/<runtimeBuildId>/`; `runtime/current` selects the terminal CLI.
The app retains the current and previous builds for recovery and removes older
unused builds only after a successful health check.

### Service permissions after an update

App-managed Bun services use a stable executable path,
`<state>/runtime/service/bun`, to preserve Messages Automation permission across
updates. The first move to this path, including migration from Node, requires
Automation approval once.

Replacing an ad-hoc or source-built Bun can also reset Full Disk Access, even
if System Settings still shows it enabled. Grant access again for
`<state>/runtime/service/bun`.

### Local authentication

Local connections prefer configured `gateway.auth.token` or
`gateway.auth.password` credentials over the app's environment variables,
matching Gateway startup. Environment credentials are fallbacks when no
configured credential resolves. Remote connections keep environment overrides.

If token authentication is selected or implicit and no credentials exist in
config or the child environment, the app saves a token before starting its
Gateway. Failure to save stops setup with a retryable error. Existing credentials,
SecretRefs, and other auth modes stay unchanged; unreadable credential sources
are not overwritten. This also applies to a local Gateway alongside a remote
primary. See [Gateway configuration](/gateway/config-gateway).

### Credential recovery

Credential and local runtime-pin migrations run before the app selects its
Gateway runtime. Existing private keys and explicit pins are preserved;
a migration conflict stops startup and shows recovery guidance.

After an in-place app update, the app stops a previous build's app-managed
Gateway before preparing credentials and installing the updated service.
Normal migrations complete automatically; unsupported or inconsistent state
requires Doctor recovery.

The app leaves a local Gateway on the extended-stable channel, a channel install
policy, or an independently managed service at its selected version. When
credential maintenance is required but a running Gateway still holds the shared
state, the app leaves that Gateway running and stops before the maintenance.
This conflict does not establish version incompatibility: maintenance can also
reconcile a receipt after a filesystem remount without changing the credential
layout.

The app explains which owner keeps the Gateway and offers **Retry**. Resolve the
reported conflict through the tool that manages the Gateway, then choose
**Retry**. Change the Gateway or app version only if recovery identifies a
version incompatibility. Background launches print the same guidance and quit.
Other credential preparation failures keep the generic recovery alert.

For storage, migration, and rollback details, see
[local client credentials](/reference/database-schemas/versioning#local-client-credentials).

## Related

- [macOS app](/platforms/macos)
- [Gateway runbook](/gateway)
