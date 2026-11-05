---
summary: "Run, update, and troubleshoot the Gateway included with the macOS app"
doc-schema-version: 1
read_when:
  - Packaging OpenClaw.app
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
Eligible app-managed Node services migrate to bundled Bun while staying
background services.

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

The app preserves an operator-created `openclaw` file. It only replaces its own
wrapper or a recognized `install-cli.sh` wrapper.

### Existing and development Gateways

Remote connections and independently managed local Gateways skip runtime
installation. Attach-only mode does not prompt for a CLI to run the app's node.

Pausing does not change who manages the Gateway, even if stopping an app-managed
service removes its LaunchAgent record. If an independent endpoint is unavailable
when reconnecting, local setup becomes available again. If the service ownership
record cannot be read, installation stops: check the LaunchAgent and retry.

Unbundled DEBUG builds keep the developer installer and channel chooser. The
installer downloads and builds in a private temporary directory. If the inherited
temporary directory is inaccessible, it uses a private directory under `/tmp`.

### Set up Chrome

In the dashboard, choose **Settings → This Mac → Set up Chrome on this device**.
This also works on remote-only and attach-only Macs. Use the same action to retry.

Setup uses the validated private runtime and registers the native helper before
requesting the Store extension. You approve Chrome's permissions. It does not run
Gateway-wide Doctor or migrate Gateway state.

Startup alone does not inspect or change Chrome data. After you start setup, the
default profile maintains registration across CLI updates for that app session.
See [Chrome extension](/tools/chrome-extension).

## Manual recovery

Use **Retry setup** after a failed bundled setup. If the bundled runtime is
missing or incompatible, reinstall OpenClaw.app. Installing a global CLI does
not repair the app's runtime.

If the runtime crashes with an illegal instruction (`SIGILL`), the app stops
automatic restarts and saves the crash output in the Gateway log. Update or
reinstall the app; include the log if the failure continues. The app does not
automatically switch to Node.

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

The app preserves settings from the Gateway's generated service environment and
rereads that file on later app launches. If a service has settings that would be
lost after switching to app hosting, the app leaves the service unchanged and
asks you to move the needed settings into the profile's persistent configuration
or `.env` file. Run `openclaw gateway install --force`, then retry the hosting
change. This uses the Gateway CLI's existing persistence rules for
provider credentials and referenced configuration; arbitrary ambient variables
are not guaranteed to persist through a new service installation.

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

<Accordion title="Runtime pins and migration state">

Runtime intent lives in the daemon-owned local SQLite store
`<state>/control/services.sqlite`, independently of the selected shared-state
engine. The app reads typed intent through its bundled CLI; it does not open the
shared database. Unknown, malformed, or stale intent preserves the service and
requires an explicit runtime selection before replacement. A pending migration is
reported as `migrationPending`; update and resume preserve the current runtime
until Doctor or a CLI start/repair completes it. An app-hosted resume that runs
neither Doctor nor the CLI start fence may keep the receipt pending; the next
CLI start/repair or `openclaw doctor` completes it.

A newly installed app-managed Bun service is pinned to
`<state>/runtime/<runtimeBuildId>/bin/bun`, with the matching package and
`OPENCLAW_SQLITE_LIBRARY` environment. After an app update, the app reinstalls
only services it owns whose executable is inside `<state>/runtime/` onto the new
concrete build. A service using an executable outside that directory stays
unchanged, including an unpinned executable. The update window reports
"Gateway service uses an operator-pinned runtime; update it yourself."

</Accordion>

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
`service.foreignLaunchdJobs`.

For warnings, recent external forced restarts in
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

Doctor removes a foreign job only when:

- Its direct arguments or literal, straight-line script invoke an absolute
  OpenClaw path with a Gateway lifecycle subcommand.
- For shell jobs, no launchd environment entries alter shell execution.

Other jobs are reported and left unchanged. These checks inspect command
metadata, not binary executability, interpreter availability, or quarantine state.

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

### Logs and installation identity

- Gateway stdout: `~/Library/Logs/openclaw/gateway.log` (profiles use
  `gateway-<profile>.log`)
- Gateway stderr: merged into the same `gateway.log` file, so startup failures
  that happen before the logger starts are still recorded
- If the host loops with repeated `EADDRINUSE` or fast restarts, check for
  duplicate `ai.openclaw.gateway` / `ai.openclaw.node` LaunchAgents and the
  launchd-marker workaround in
  [Gateway troubleshooting](/gateway/troubleshooting#macos-launchd-supervisor-loop-with-duplicate-gateway%2Fnode-launchagents).

When a shell CLI and the running Gateway report the same version, they can still
belong to different physical installations. Inspect `openclaw gateway status --deep`
and `openclaw health` alongside the shell version to identify the service command
and runtime. A terminal shim path such as `/opt/homebrew/bin/openclaw` alone does
not identify its package owner. For app-owned recovery, choose **Retry** in the app;
it uses the app's captured runtime and existing repair owners. Keep recovery
preferences intact. Successful health verifies readiness; required repair work
must also complete before the update receipt settles.

## App-hosted lifecycle and updates

Update OpenClaw.app to update its bundled Gateway. Bundled installations do not
run npm self-update. Rebuilds with the same public version also replace the
runtime.

### Startup and crash recovery

During startup, readiness probes control retries and their deadline. Connection
refusals while the Gateway boots do not leave an exponential delay once it is
ready.

After a child process crashes, the app retries after 1, 2, 4, and 8 seconds.
The failure count resets after 60 healthy seconds. A fifth rapid failure stops
restarts and displays the error with the Gateway log tail.

Pausing or quitting closes the host lifeline and allows graceful shutdown before
forcing an unresponsive process group to exit.

### What an app update does

1. Prepares the new runtime and drains the app's producer.
2. Runs Doctor through the selected runtime. Doctor handles core migrations and
   configured plugin host-link repair; the app handles service installation and
   activation.
3. Restarts the Gateway in its selected hosting mode.
4. Verifies health before removing old builds.

A paused Gateway stays paused. External services and channel policies keep their
existing ownership rules.

If a required repair is refused, recovery stays pending. The app restores the
previous service when native custody permits. If Doctor cleanup
cannot be confirmed, the Gateway stays stopped; preserve the reported custody
diagnostics before retrying. Conditional plugin warnings and pending repair
records remain available.

A missing `runtime/current` link is repaired by copying the bundled runtime.
Old builds stay until a successful update restores the previous-build record.
Invalid existing metadata remains a retryable error.

### Legacy and remote installations

Existing app-managed Node services update and repair through their installed CLI,
including health checks, and keep their runtime pin. A bundled runtime left on
disk does not transfer ownership of an attached Node service to the app. If the
legacy runtime cannot be verified, the update remains retryable; the app does
not replace it with a fresh bundled installation.

A paused legacy Node installation keeps background-service hosting even if an
older app removed its LaunchAgent. While paused, the app records that preference
without inspecting or changing the runtime. On resume, it recovers the managed
Node CLI before updating. This also applies to named profiles.

With a remote primary, an installed legacy Mac node service updates through its
own captured CLI. The app then updates its local companion Gateway separately.
The update stays pending until both required runtimes are healthy. The bundled
private worker is not a Node LaunchAgent; absent node services and named profiles
do not trigger this legacy node-service update.

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

Before replacing an app-managed service, the app checks its saved runtime choice
using the bundled CLI, runtime, and environment:
`gateway status --runtime-intent-only --json`.
This local inspection remains available when the Gateway or PostgreSQL is stopped.
It passes the observed revision and service definition to the installer after
checking that it still manages the service. Failed or unknown inspection stops
the install. If an operator changes the service or runtime pin before installation begins, the CLI
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

#### Installations that stay on their current runtime

Automatic registered-service migration excludes:

- Channel-policy installations.
- Independently managed services.
- Services with operator runtime pins, including pins to the app's Node tools.
- Named profiles.

#### Resume a paused legacy installation

Older apps removed the LaunchAgent when paused. After onboarding in local mode,
the surviving app-managed Node installation preserves service hosting even when
the LaunchAgent is absent. This applies to default and named profiles using an
exact or unset install policy. While paused, the app only records the hosting
preference; it does not update, seed, or install a Gateway.

On Resume, an older Node installation uses its core updater to reach the app's
version without restarting a service. It then seeds Bun, installs the service,
and verifies health in the same startup attempt. If the runtime switch fails,
the app reinstalls and verifies the same-version Node service and shows the
update failure with Retry. Fresh profiles retain app hosting; channel policies,
attach-only profiles, and independently managed installations are not adopted.

A compatible newer Node installation resumes through its existing selected CLI;
the app does not downgrade it or switch it to the app's older bundled runtime.
Health verification, required migration completion, and current runtime ownership
still govern recovery completion.

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

Expand these sections for packaging and advanced troubleshooting.

<AccordionGroup>
<Accordion title="What the app includes">

`Contents/Resources/runtime` contains the OpenClaw Bun fork, a signed SQLite
library with extension loading, and matching CLI, Gateway, and Control UI.
The private `node worker` and local Chrome-extension setup also use Bun.
There is no Node executable.

Universal apps share JavaScript and include universal Bun/SQLite binaries plus
architecture-specific native dependencies. Before launch, the app checks the
package version, commit, build time, and build ID. Replacing or rebuilding the
app replaces its runtime, even at the same version. Moving the app or deleting
the build checkout does not change its runtime.

</Accordion>
<Accordion title="Local authentication">

Before starting an app-hosted Gateway, the app saves a token if token auth is
selected or implicit and neither config nor the child environment provides
credentials. Failure to save stops setup with a retryable error. This also
applies to a local Gateway alongside a remote primary.

Existing auth modes, credentials, SecretRefs, remote fallback credentials,
config includes, trusted dotenv credentials, and enabled login-shell imports
are preserved. Unreadable or unsafe-to-resolve sources leave auth unchanged.
Trusted dotenv files are the profile's `.env` and, for the default state
directory, `~/.config/openclaw/gateway.env`.

</Accordion>
<Accordion title="Runtime files and update ownership">

The app copies the runtime to `<state>/runtime/<runtimeBuildId>/` using an APFS
clone when available, otherwise a file copy. It publishes the copy atomically
after build-identity and Bun checks pass.

- Child processes and app-managed Bun services use the concrete build directory
  with matching packages and SQLite libraries.
- `runtime/current` selects the terminal CLI runtime.
- Current and previous builds are retained. Older builds are removed only after
  Gateway health succeeds and no process uses them.

Packaging writes `openclaw-install-owner.json` at the package root:
`schemaVersion: 1`, `owner: "macos-app"`, `displayName: "OpenClaw.app"`, and
`updateHint: "Update OpenClaw.app to update this Gateway."`. Sparkle owns these
updates. Core reports that owner, skips registry update checks, and refuses
self-update and runtime migration.

A host can set `OPENCLAW_GATEWAY_HOST_LIFELINE=stdin` and keep the stdin writer
open. EOF or a pipe error requests graceful shutdown. App-hosted Gateways use
this to exit even if the app ends unexpectedly.

</Accordion>
<Accordion title="Private worker and credentials">

Worker bootstrap validates core and node config read-only, without Gateway-wide
Doctor preflight or channel-schema validation. Node plugins validate their own
settings before publishing commands; the node runtime owns MCP clients.
Startup still runs client-credential and exec-approval migrations, so startup
as a whole is not read-only.

Before connecting, the app loads identities and cached device tokens from local
`client/credentials.sqlite`, not the selected Gateway database. Same-user
credential operations are bounded, with exclusive SQLite access per operation.
New clients can create identities while PostgreSQL or the Gateway is offline;
shared approval policy still depends on its state owner.

The matching bundled CLI prepares credentials noninteractively before native
admission. Gateway and node startup use the same migration owner:

- Normal pending migrations and validated remounts complete automatically,
  without a Doctor command or recovery prompt.
- Recognized credential-only native version-zero databases can be extracted
  under exclusive custody before PostgreSQL bootstrap.
- Unknown data or other application tables require the supported Doctor/port
  route. Doctor also handles unsupported or inconsistent source state.
- Private keys are preserved. Migration failure never silently replaces them.
  Update older apps after shared credential retirement.

Read-only imports leave independent native sources available for rollback.
The local copy records source identity and content hash: unchanged sources keep
refreshed tokens; changed sources rebuild the copy. Consumed JSON imports stay
consumed.

</Accordion>
</AccordionGroup>

## Related

- [macOS app](/platforms/macos)
- [Gateway runbook](/gateway)
