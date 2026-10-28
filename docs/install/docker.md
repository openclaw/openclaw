---
summary: "Optional Docker-based setup and onboarding for OpenClaw"
read_when:
  - You want a containerized Gateway instead of local installs
  - You are validating the Docker flow
  - You are migrating from ClawDock shell helpers
title: "Docker"
---

Docker is **optional**. Use it for an isolated, throwaway Gateway environment or a host without local installs. If you already develop on your own machine, use the normal install flow instead.

The default Docker sandbox backend uses only the `docker` CLI. Set the backend to `"podman"` to select native Podman directly. Sandboxing is off by default and does not require the Gateway itself to run in a container. SSH and OpenShell sandbox backends are also available; see [Sandboxing](/gateway/sandboxing).

Hosting mutually untrusted users? Run a separate Gateway for each trust boundary, ideally under separate OS users or hosts. See [Security trust model](/gateway/security/trust-model).

## Prerequisites

- Docker Desktop (or Docker Engine) + Docker Compose v2
- At least 6 GB RAM for a local source image build; pre-built images avoid this build requirement
- Enough disk for images and logs
- On a VPS/public host, review [Security hardening for network exposure](/gateway/security), especially the Docker `DOCKER-USER` firewall chain

## Containerized Gateway

<Steps>
  <Step title="Build the image">
    From the repo root:

    ```bash
    ./scripts/docker/setup.sh
    ```

    This builds the Gateway image locally as `openclaw:local`. To use a pre-built image instead:

    ```bash
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    Pre-built images are published first to the [GitHub Container Registry](https://github.com/openclaw/openclaw/pkgs/container/openclaw). GHCR is the primary registry for release automation, pinned deployments, and provenance checks. The same release publishes a Docker Hub mirror at `openclaw/openclaw`:

    ```bash
    export OPENCLAW_IMAGE="openclaw/openclaw:latest"
    ./scripts/docker/setup.sh
    ```

    Use `ghcr.io/openclaw/openclaw` or `openclaw/openclaw` and avoid unofficial mirrors, which don't share OpenClaw's release timing or retention policy. Version-specific tags include releases such as `2026.9.3` and prereleases such as `2026.9.1-beta.1`. Stable releases move `latest` and `main`; trailing-month Gateway releases move only `extended-stable`. Variants include `slim`, `main-slim`, `extended-stable-slim`, `latest-browser`, `main-browser`, and `extended-stable-browser`. The default images bundle the `codex` and `diagnostics-otel` plugins. A `-browser` variant also ships with Chromium baked in for the [Gateway-controlled browser](/install/docker#using-the-control-ui-browser). The agent sandbox browser uses a separate image.

  </Step>

  <Step title="Airgapped rerun">
    On offline hosts, transfer and load the image first:

    ```bash
    docker load -i openclaw-image.tar
    export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest"
    ./scripts/docker/setup.sh --offline
    ```

    `--offline` verifies `OPENCLAW_IMAGE` already exists locally, disables implicit Compose pulls/builds, then runs the normal flow: `.env` sync, permission fixes, onboarding, Gateway config sync, Compose startup.

    If `OPENCLAW_SANDBOX=1`, offline setup also checks the configured default and per-agent sandbox images on the daemon behind `OPENCLAW_DOCKER_SOCKET`, including the browser-contract label on Docker-backed browser images. If a required image is missing or stale, setup exits without changing sandbox config rather than reporting a broken success.

  </Step>

  <Step title="Complete onboarding">
    The setup script runs onboarding automatically:

    - prompts for provider API keys
    - generates a Gateway token and writes it to `.env`
    - creates the legacy auth-profile secret key directory
    - starts the Gateway via Docker Compose

    Pre-start onboarding and config writes run through `openclaw-gateway` directly (with `--no-deps --entrypoint node`), since `openclaw-cli` shares the Gateway's network namespace and only works once the Gateway container exists.

  </Step>

  <Step title="Open the Control UI">
    Open `http://127.0.0.1:18789/` and paste the token written to `.env` into Settings. If you switched the container to password auth, use that password instead.

    Need the URL again?

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

    With a custom `OPENCLAW_GATEWAY_PORT`, replace port `18789` in the printed URL with your host port before opening it in the browser; keep the rest of the URL intact. Dashboard commands inside either container use the internal listener port.

  </Step>

  <Step title="Configure channels (optional)">
    ```bash
    # WhatsApp (QR)
    docker compose run --rm openclaw-cli channels login

    # Telegram
    docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"

    # Discord
    docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
    ```

    Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

  </Step>
</Steps>

### Using the Control UI browser

The [Control UI Browser panel](/web/control-ui/panels#browser-panel) displays a
browser controlled by the Gateway. It is separate from the browser on your laptop
or phone that opens the dashboard. For a local managed browser with a Docker
Gateway, Chromium must be available **inside the Gateway container**.

For a new installation, use the official browser-equipped image with the normal
Compose setup; no custom Dockerfile is needed:

```bash
export OPENCLAW_IMAGE="ghcr.io/openclaw/openclaw:latest-browser"
./scripts/docker/setup.sh
```

For a pinned deployment, choose a release's `-browser` tag instead of the moving
`latest-browser` tag. For an existing Compose installation, change `OPENCLAW_IMAGE`
in its `.env` to the browser variant, then pull and recreate the Gateway using
the same Compose files and overlays as your current deployment:

```bash
docker compose pull openclaw-gateway openclaw-cli
docker compose stop openclaw-gateway
docker compose up -d openclaw-gateway
```

Keep your existing volumes, ports, and other settings. Do not rerun setup with an
empty shell environment to change only the image: setup rewrites `.env` from the
current shell and defaults.

An existing home volume or bind mount covering `/home/node/.cache/ms-playwright`
can hide the image's bundled Chromium. If browser discovery still fails after the
image switch, check those mounts. Preserve the data, then either provision
Chromium in the mounted home or adjust the mounts to leave the image's browser
cache visible; recreating the container does not refresh a populated home volume.

For a new installation from a local source build, bake Chromium into the image:

```bash
OPENCLAW_IMAGE=openclaw:local OPENCLAW_INSTALL_BROWSER=1 ./scripts/docker/setup.sh
```

`OPENCLAW_INSTALL_BROWSER=1` installs full Chromium and headless shell, preserving
existing Playwright scripts that use default headless launches. Choose `chromium`
to install only full Chromium, or `headless-shell` for a smaller, headless-only image:

```bash
OPENCLAW_IMAGE=openclaw:local OPENCLAW_INSTALL_BROWSER=headless-shell ./scripts/docker/setup.sh
```

All modes use the repository-pinned Playwright installer, including its system
libraries, fonts, and FFmpeg helper. Empty or `0` omits the browser. These are
build-time choices; setting them on an already-built container does not install
or replace a browser. Headless shell cannot provide a headed browser window or
Chrome extensions. Keep full Chromium for those workflows and validate your sites
before switching. Neither browser distribution is MIT-only; inventory the actual
image and preserve all third-party license notices.

OpenClaw automatically discovers full Chromium only. A `headless-shell` image
requires an explicit shell executable path on a separate managed profile. Find
the installed path inside the container (the revision directory changes with
Playwright updates):

```bash
find /home/node/.cache/ms-playwright -type f -name chrome-headless-shell
```

Set `browser.profiles.shell.executablePath` to that path, give the profile its own
`cdpPort`, and keep it headless. Select that profile when starting the browser.
Do not reuse an existing full Chromium profile: switching distributions can
discard localStorage. See [Browser configuration](/tools/browser/configuration).

With the explicit `chromium` mode,
your own Playwright scripts must use `channel: "chromium"` for headless launches;
Playwright's default headless launch expects the separate shell binary. Keep `1`
to retain both binaries without changing existing scripts.
The bundled Diffs PNG/PDF renderer supports all image modes. After explicit and
system-browser choices, it selects Playwright's full Chromium when installed and
otherwise retains Playwright's default headless-shell selection.

The image supplies Chromium, not a replacement for your browser configuration:

- Keep browser control enabled (`browser.enabled`). Use a local managed profile
  such as `openclaw` for the container's Chromium, not an extension, attach-only,
  or remote-CDP profile intended for another browser.
- OpenClaw auto-detects the image's Playwright-managed Chromium on Linux. An
  explicit `browser.executablePath` or profile executable path must point to a
  binary inside the container; a path from your laptop will not work there.
- Managed browsers run headless by default. Check explicit
  `browser.headless`, profile headless settings, and `OPENCLAW_BROWSER_HEADLESS`
  overrides if startup reports a missing display. See [Browser configuration](/tools/browser-control).
- Connect with `operator.admin` access to a Gateway advertising `browser.request`.
  Open **+ → Browser** in the Chat side panel, navigate to a page, and confirm that
  its snapshot loads and navigation works. Loading the dashboard alone does not
  verify that Chromium can start.

This is not the separate [sandboxed browser](/gateway/sandboxing#sandboxed-browser)
container used by sandboxed agent sessions. Selecting a Gateway `-browser` image
does not build or configure that sandbox image.

### Headless bootstrap

For an unattended container host, put provider, Gateway, and channel credentials in the Compose `.env` file so both the one-shot bootstrap container and the long-running Gateway receive the same values:

```bash
OPENAI_API_KEY=<provider-key>
OPENCLAW_GATEWAY_TOKEN=<gateway-token>
TELEGRAM_BOT_TOKEN=<bot-token>
```

Run onboarding and channel provisioning without a pseudo-TTY, then start the Gateway:

```bash
docker compose run -T --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
  --skip-channels \
  --no-install-daemon
docker compose run -T --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js channels add --channel telegram --use-env
docker compose up -d openclaw-gateway
```

The channel command fails before changing config if a plugin-declared environment variable is missing. Keep `TELEGRAM_BOT_TOKEN` in `.env` after bootstrap: `--use-env` leaves credential lookup to the environment without copying the token into `openclaw.json`, and the running Gateway needs the same variable. When channel config changes after startup, the Gateway's config watcher hot-reloads the affected channel automatically.

See [`openclaw channels`](/cli/channels) for credential-flag alternatives and other channel plugins.

### Manual flow

```bash
BUILD_GIT_COMMIT="$(git rev-parse HEAD)"
BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker build \
  --build-arg "GIT_COMMIT=${BUILD_GIT_COMMIT}" \
  --build-arg "OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}" \
  -t openclaw:local -f Dockerfile .
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js onboard --mode local --no-install-daemon
docker compose run --rm --no-deps --entrypoint node openclaw-gateway \
  dist/index.js config set --batch-json '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]'
docker compose up -d openclaw-gateway
```

The Docker context excludes `.git`. Pass the source identity as build arguments
as shown above so the image's About screen reports the checked-out commit and
one build timestamp. `scripts/docker/setup.sh` resolves and passes both values
automatically.

<Note>
Run `docker compose` from the repo root. If you enabled `OPENCLAW_EXTRA_MOUNTS` or `OPENCLAW_HOME_VOLUME`, the setup script writes `docker-compose.extra.yml`; include it after any `docker-compose.override.yml` you maintain yourself, e.g. `-f docker-compose.yml -f docker-compose.override.yml -f docker-compose.extra.yml`.
</Note>

### Upgrading container images

When you replace the OpenClaw image but keep the same mounted state/config, the
image entrypoint runs `openclaw doctor --fix --non-interactive` under exclusive
maintenance ownership before starting the Gateway. This covers the default image
command and Compose's foreground Gateway command, including its selected profile.
Routine image upgrades do not require a separate Doctor pass.

Keep one Gateway replica per state volume, and stop the old container before
starting its replacement. The startup repair needs exclusive maintenance
ownership of that state; an overlapping Gateway can prevent it from completing.
For Compose, use the same files and overlays as your running deployment:

```bash
docker compose pull openclaw-gateway openclaw-cli
docker compose stop openclaw-gateway
docker compose up -d openclaw-gateway
```

In Docker Swarm, keep `replicas: 1` and use `update_config.order: stop-first` and
`rollback_config.order: stop-first`. In Kubernetes, keep `replicas: 1` and use a
`Recreate` Deployment strategy, as the [provided manifest](/install/kubernetes)
does. A shared volume is not a way to scale Gateway replicas. Back up the state
before upgrading; see [Backups](/install/backups).

Activation retains a full pre-repair copy of local state under
`<state-dir>.update-captures/` the first time Doctor captures in a container.
Later starts of the same container (`docker stop`/`docker start`, restart
policies, host reboots) still run the Doctor repair pass but skip that repeated
full copy, keep it, and still retire other Doctor copies older than 30 days;
repair-specific backups still apply. If a capture fails, the next
start tries again. A new image, a recreated container, or a container whose
`/tmp` does not persist across restarts captures again.

### Read-only container root

A read-only container root still needs writable runtime storage. For example,
with `HOME=/state` and `OPENCLAW_STATE_DIR=/state`, provide these mounts:

| Path                                                                   | Purpose                                                                                                  | Storage                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `/state`                                                               | SQLite databases and sidecars, credentials, and state ownership locks under `/state/tmp/openclaw-<uid>/` | Persistent writable volume          |
| Configured workspace directories, such as `/workspace`                 | Agent files and workspace migrations                                                                     | Persistent writable volume          |
| `/state/.cache` or the absolute directory selected by `XDG_CACHE_HOME` | Private SQLite snapshot staging                                                                          | Writable volume or tmpfs            |
| `/tmp`                                                                 | Runtime temporary files and the container activation marker                                              | Writable tmpfs                      |
| `/state.update-captures`                                               | Retained pre-repair state captures                                                                       | Separate persistent writable volume |

Set ownership so the container's UID/GID can create files and directories in each
writable location. Database files and their parent directories must be writable;
mounting only the database file writable is insufficient for SQLite sidecars.
Configured plugin storage or other file outputs may need additional mounts.
See [Gateway lock](/gateway/gateway-lock#state-and-config-locks) for the lock paths.
`TMPDIR` does not relocate state ownership locks.

The capture path is a sibling of the resolved state directory, not a child. A
writable `/state` therefore does not make `/state.update-captures` writable. If
that sibling is unavailable, standalone Doctor reports that the original state
capture was unavailable and continues. This warning does not identify the cause
of a later fatal filesystem error. Keep the capture volume private: it contains
raw pre-repair state and credentials, and is excluded from normal backups and
support exports.

For a read-only config bind such as `/run/config/openclaw.json`, set
`OPENCLAW_CONFIG_PATH=/run/config/openclaw.json` and
`OPENCLAW_CONFIG_READONLY=1` in both the Gateway and CLI container environments.
Doctor can still repair writable state, but config repairs must be applied in
your external deployment source. Invalid or legacy config that blocks startup
must be migrated there before restarting. See
[Externally managed config](/cli/config#externally-managed-config).

If startup reports `EROFS`, inspect the path and operation in the error and check
that its mount is writable. Changing file modes cannot make a read-only mount
writable. Do not delete state or lock files to repair a mount error, and do not
disable native filesystem checks.

On older Linux hosts such as Synology DSM, an unavailable `openat2` syscall can
make older images report that another Gateway owns even an empty state volume.
Current images use the guarded filesystem fallback; keep native filesystem
checks enabled. Doctor reports the underlying lock failure and recovery action
instead of treating every acquisition error as an active Gateway. Permission
errors require a writable state mount for the container user. If the filesystem
cannot provide exclusive file creation for state ownership, stop OpenClaw, back
up its state, and move the state volume to a local filesystem that supports it.
Ordinary database transactions use SQLite locking on that volume. Do not delete
state or lock files to bypass ownership.

Other CLI commands and help pass through unchanged. If you replace the image's
entrypoint, run Doctor against the same mounted state/config before launching the
Gateway; a custom entrypoint bypasses this activation step.

This includes agent database schema upgrades, shared-state audit migrations, and
legacy workspace setup imports. Before advancing database schemas, Doctor saves
verified SQLite copies beside the originals as
`<database>.pre-startup-migration-<id>.bak`. Fully declared table migrations may
instead use `.scoped.bak` archives; restore those with
`openclaw database restore-migration-backup`, never by replacing the database file.
See [declared migration scopes](/reference/database-schemas/versioning#declared-migration-backup-scopes).
The shared database and affected agent
databases use the same backup ID. Config backups and retired workspace-file
archives follow the normal Doctor repair rules. Keep these files with your
pre-upgrade backup; a rollback must restore the matching state as well as the old
image. See [rollback](/install/updating#rollback).

Retries with the same candidate build, database files, and target schemas verify and reuse the
first completed backup group for the full database inventory, including after a
partially completed migration. A temporary `.bak.capturing` file records an
unfinished capture and is durably removed before migration starts. An interrupted
capture is recaptured; a missing or damaged member of a completed group stops
migration and preserves the surviving snapshots for recovery. Repeated
failed attempts therefore do not create another full backup group each time.
Older backup groups remain available for operator-managed rollback.
Doctor records these originals for `openclaw update cleanup --dry-run`. They stay
protected until Doctor verifies that the migration completed and a later update
finishes successfully. Cleanup can then retire the recorded group after your
confirmation. Older unrecorded `.bak` files are listed as protected. Keep these
files with your pre-upgrade backups while you still need the matching rollback.

On FUSE filesystems such as Unraid's `shfs`, a missing native no-replace rename
does not require an operator step in native `auto` mode when same-directory
hardlinks are supported. fs-safe preserves the source inode and bytes through
exclusive hardlink publication and unlink. Native `require` mode still refuses
the unsupported primitive. Doctor recovers interrupted source/claim pairs without
replacing another file. Its separate missing-addon/native-off compatibility path
syncs the source and directory before removing the old name; native moves do not
promise per-move crash durability. Archive hardening and durable recovery
checkpoints remain owned by Doctor.
SQLite backup verification rechecks snapshot bytes when FUSE modification or change timestamps drift, while still rejecting changed contents or file identities.

Readiness remains false while the default or system agent database is refused,
and the readiness response includes the admission reason. A refused optional
agent remains isolated while healthy agents can serve requests.

Missing or drifted required SQLite indexes are rebuilt by the schema migration
owner before session startup completes. Repair warnings identify the agent,
database path, rebuilt indexes, and elapsed time. Current-schema shape refusal
reports list all affected databases in stable path order. Missing required tables,
incompatible columns, and other changes that cannot be reconstructed safely still require Doctor; startup
does not recreate a missing data table as an empty one.

On Linux hosts without file creation timestamps, normal SQLite writes and
permission repairs can change the reported file birth time. These changes do
not invalidate the open database; actual file replacement still stops admission.

Startup exits with code `78` when required state cannot be migrated safely:
for example, source identities conflict, data is unreadable, another writer owns
the state, or the filesystem provides no safe, durable way to publish a claim.
The retained source, claim, and backups are recovery inputs; do not delete them to
silence the error. If the filesystem lacks the required primitives, stop the
Gateway and expose the same data through its native backing filesystem before
retrying (for example, an Unraid pool path instead of the `shfs` share).

With a restart policy, Docker, Podman, or Kubernetes may show
the Gateway container restarting. Keep the mounted state volume, then run the
same image once with `openclaw doctor --fix` as the container command, using the
same state/config mounts the Gateway uses:

```bash
docker run --rm -v <openclaw-state>:/home/node/.openclaw <image> openclaw doctor --fix
podman run --rm -v <openclaw-state>:/home/node/.openclaw <image> openclaw doctor --fix
```

After doctor finishes, restart the Gateway container with its default command.
In Kubernetes, run the same command in a one-off Job or debug pod mounted to the
same PVC. First scale the Gateway workload to zero and wait for its pods to
terminate; in Swarm, scale the Gateway service to zero and wait for its tasks to
stop. Keep the workload stopped until Doctor finishes, then restore one replica.
If ownership is still refused after the old container has stopped, follow
[Gateway lock recovery](/gateway/gateway-lock#recover-a-crashed-foreign-owner).
Do not delete lock files or repeatedly restart competing containers.

After the container is running again, run the read-only deployment preflight
against the same mounted state:

```bash
docker compose run --rm openclaw-cli doctor --json
```

### Source-built images with selected plugins

`OPENCLAW_EXTENSIONS` selects plugin manifest ids from the source checkout;
existing source-directory names are also accepted when they differ. The Docker
build resolves the selection to source directories once, installs production
dependencies, links each selected plugin's own runtime dependencies under its
packaged root in `/app/dist/extensions/<id>`, and includes the selected plugin
runtime in the image. Source checkouts also compile first-party plugins
published separately with
`openclaw.build.bundledDist: false`; that marker still preserves the plugin's
external npm or ClawHub ownership and does not change either artifact contract.
Unknown, invalid, or ambiguous ids fail the image build.
Custom package builds using `scripts/package-openclaw-for-docker.mjs --bundle-plugin`
retain each selected plugin's declared npm bundles from its own installation,
including their installed runtime dependencies and local patches. Packaging does
not change the checkout's dependency links or shared package store.

After the frozen production install, Docker also composes the selected plugins'
exact production and optional pins into the final distribution manifest and
links their already-installed package identities at the root resolution scope.
This lets plugin-owned code emitted into shared root chunks resolve the same
packages while retaining the plugin-local links needed by plugin-root chunks.
The composition performs no second install or dependency resolution and fails
instead of replacing an incompatible root binding.
This includes WhatsApp: `OPENCLAW_EXTENSIONS=whatsapp` compiles and packages its
runtime. Ordinary source builds generate its runtime through the separate
external-plugin build path; root npm artifacts continue to exclude it. Selected
plugins must compile successfully; unselected external plugin source and
runtime output are pruned.

The install layer stages every workspace's `package.json` so frozen-lockfile
validation can check the complete workspace. The build stage installs workspace
dependencies needed to compile plugin assets; the production stage installs only
core, shared packages, and required or selected plugins. Staging a plugin manifest
does not select that plugin for the runtime image.

For example, these commands build separate, multi-architecture standalone
FakeCo Gateway images for ClickClack, Slack, and Microsoft Teams. ClawRouter is
already part of the root OpenClaw runtime, so the ClickClack image selects only
`clickclack`. The explicit empty browser argument keeps the default image free
of Chromium:

```bash
SOURCE_SHA="$(git rev-parse HEAD)"
BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REGISTRY="registry.example.com/fakeco"

build_gateway_image() {
  gateway="$1"
  selected_plugin="$2"
  docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --build-arg "GIT_COMMIT=${SOURCE_SHA}" \
    --build-arg "OPENCLAW_BUILD_TIMESTAMP=${BUILD_TIMESTAMP}" \
    --build-arg "OPENCLAW_EXTENSIONS=${selected_plugin}" \
    --build-arg OPENCLAW_INSTALL_BROWSER= \
    --provenance=mode=max \
    --sbom=true \
    --tag "${REGISTRY}/openclaw-${gateway}:${SOURCE_SHA}" \
    --push \
    .
}

build_gateway_image clickclack clickclack
build_gateway_image slack slack
build_gateway_image teams msteams
```

Use `--platform linux/arm64 --load` or `--platform linux/amd64 --load` for a
single native local build. Multi-platform output and attached SBOM/provenance
require a registry or another Buildx output that preserves attestations. After
pushing, inspect the manifest and deploy the immutable digest rather than the
mutable source-SHA tag:

```bash
docker buildx imagetools inspect \
  "${REGISTRY}/openclaw-clickclack:${SOURCE_SHA}"
# Deploy: registry.example.com/fakeco/openclaw-clickclack@sha256:<manifest-digest>
```

These images are for standalone OCI-based Gateways and generic Docker users.
Crabhelm-managed Gateways do not consume them: that delivery path builds a
separate x86_64 appliance archive containing an OpenClaw npm tarball and pins
the Node, archive, and manifest digests. Build that appliance independently
from the same landed OpenClaw source.

To test bundled plugin source against a packaged image, mount one plugin source directory over its packaged source path, e.g. `OPENCLAW_EXTRA_MOUNTS=/path/to/fork/extensions/synology-chat:/app/extensions/synology-chat:ro`. That overrides the matching compiled `/app/dist/extensions/synology-chat` bundle for the same plugin id. Restart the Gateway after adding or changing a mount; runtime loading and setup use the mounted source.

### Observability

OpenTelemetry export is outbound from the Gateway container to your OTLP collector; it needs no published Docker port. To include the bundled exporter in a locally built image:

```bash
export OPENCLAW_EXTENSIONS="diagnostics-otel"
export OTEL_EXPORTER_OTLP_ENDPOINT="http://otel-collector:4318"
export OTEL_SERVICE_NAME="openclaw-gateway"
./scripts/docker/setup.sh
```

Official prebuilt images already bundle `diagnostics-otel`; install `@openclaw/diagnostics-otel` yourself only if you removed it. To enable export, allow and enable the `diagnostics-otel` plugin in config, then set `diagnostics.otel.enabled=true` (see the full example in [OpenTelemetry export](/gateway/opentelemetry)). Collector auth headers go through `diagnostics.otel.headers`, not Docker environment variables.

Prometheus metrics reuse the already-published Gateway port. Install `@openclaw/diagnostics-prometheus`, enable the `diagnostics-prometheus` plugin, then scrape:

```text
http://<gateway-host>:18789/api/diagnostics/prometheus
```

The route is protected by Gateway authentication; don't expose a separate public `/metrics` port or unauthenticated reverse-proxy path. See [Prometheus metrics](/gateway/prometheus).

### Health checks

Container check endpoints (no auth required):

```bash
curl -fsS http://127.0.0.1:18789/healthz   # liveness
curl -fsS http://127.0.0.1:18789/startupz  # startup and traffic admission
curl -fsS http://127.0.0.1:18789/readyz    # deep, channel-aware readiness
```

The image's built-in `HEALTHCHECK` pings `/healthz`; repeated failures mark the container `unhealthy` so orchestrators can restart or replace it.
It uses the live Gateway lock's port first, then `OPENCLAW_GATEWAY_PORT`, then
the configured port. An explicit environment port still works when the config
cannot be loaded.
Use `/startupz` for an orchestrator startup or readiness check so a failed channel account does not remove the otherwise healthy Gateway and Control UI from service. Use `/readyz` for monitoring that intentionally treats hard channel failures as not ready. See [Health checks](/gateway/health#http-probes) for response details.

Authenticated deep health snapshot:

```bash
docker compose exec openclaw-gateway sh -lc 'node dist/index.js gateway health --token "$OPENCLAW_GATEWAY_TOKEN"'
```

## Detailed topics

<CardGroup cols={2}>
  <Card title="Environment variables" href="/install/docker/environment-variables" icon="gear">
    The full variable table, apt/pip build extras, and build-memory tuning.
  </Card>
  <Card title="Networking and storage" href="/install/docker/networking-and-storage" icon="server">
    LAN vs loopback, host.docker.internal, Claude CLI, Bonjour, and mounted state.
  </Card>
  <Card title="Compose operations" href="/install/docker/compose-operations" icon="terminal">
    Compose command table, sandbox/CI/DNS/EACCES accordions, and image refreshes.
  </Card>
  <Card title="Sandbox and troubleshooting" href="/install/docker/sandbox-and-troubleshooting" icon="shield">
    Enabling the agent sandbox plus the Docker troubleshooting accordions.
  </Card>
</CardGroup>

- <a id="environment-variables" />[Environment variables](/install/docker/environment-variables#environment-variables)
- <a id="lan-vs-loopback" />[LAN vs loopback](/install/docker/networking-and-storage#lan-vs-loopback)
- <a id="host-local-providers" />[Host local providers](/install/docker/networking-and-storage#host-local-providers)
- <a id="claude-cli-backend-in-docker" />[Claude CLI backend in Docker](/install/docker/networking-and-storage#claude-cli-backend-in-docker)
- <a id="bonjour-%2F-mdns" /><a id="bonjour-/-mdns" />[Bonjour / mDNS](/install/docker/networking-and-storage#bonjour-%2F-mdns)
- <a id="storage-and-persistence" />[Storage and persistence](/install/docker/networking-and-storage#storage-and-persistence)
- <a id="clawdock-migration" />[ClawDock migration](/install/docker/compose-operations#clawdock-migration)
  - <a id="enable-agent-sandbox-for-docker-gateway" />[Enable agent sandbox for Docker gateway](/install/docker/compose-operations#enable-agent-sandbox-for-docker-gateway)
  - <a id="automation-ci-non-interactive" />[Automation / CI (non-interactive)](/install/docker/compose-operations#automation-ci-non-interactive)
  - <a id="shared-network-security-note" />[Shared-network security note](/install/docker/compose-operations#shared-network-security-note)
  - <a id="docker-desktop-dns-failures-in-openclaw-cli" />[Docker Desktop DNS failures in openclaw-cli](/install/docker/compose-operations#docker-desktop-dns-failures-in-openclaw-cli)
  - <a id="permissions-and-eacces" />[Permissions and EACCES](/install/docker/compose-operations#permissions-and-eacces)
  - <a id="faster-rebuilds" />[Faster rebuilds](/install/docker/compose-operations#faster-rebuilds)
  - <a id="power-user-container-options" />[Power-user container options](/install/docker/compose-operations#power-user-container-options)
  - <a id="openai-codex-oauth-headless-docker" />[OpenAI Codex OAuth (headless Docker)](/install/docker/compose-operations#openai-codex-oauth-headless-docker)
  - <a id="base-image-metadata" />[Base image metadata](/install/docker/compose-operations#base-image-metadata)
- <a id="image-contents-and-security-scanning" />[Image contents and security scanning](/install/docker/compose-operations#image-contents-and-security-scanning)
- <a id="weekly-image-refreshes" />[Weekly image refreshes](/install/docker/compose-operations#weekly-image-refreshes)
- <a id="running-on-a-vps%3F" /><a id="running-on-a-vps" />[Running on a VPS?](/install/docker/compose-operations#running-on-a-vps%3F)
- <a id="agent-sandbox" />[Agent sandbox](/install/docker/sandbox-and-troubleshooting#agent-sandbox)
  - <a id="quick-enable" />[Quick enable](/install/docker/sandbox-and-troubleshooting#quick-enable)
- <a id="troubleshooting" />[Troubleshooting](/install/docker/sandbox-and-troubleshooting#troubleshooting)
  - <a id="image-missing-or-sandbox-container-not-starting" />[Image missing or sandbox container not starting](/install/docker/sandbox-and-troubleshooting#image-missing-or-sandbox-container-not-starting)
  - <a id="permission-errors-in-sandbox" />[Permission errors in sandbox](/install/docker/sandbox-and-troubleshooting#permission-errors-in-sandbox)
  - <a id="custom-tools-not-found-in-sandbox" />[Custom tools not found in sandbox](/install/docker/sandbox-and-troubleshooting#custom-tools-not-found-in-sandbox)
  - <a id="oom-killed-during-image-build-exit-137" />[OOM-killed during image build (exit 137)](/install/docker/sandbox-and-troubleshooting#oom-killed-during-image-build-exit-137)
  - <a id="unauthorized-or-pairing-required-in-control-ui" />[Unauthorized or pairing required in Control UI](/install/docker/sandbox-and-troubleshooting#unauthorized-or-pairing-required-in-control-ui)
  - <a id="gateway-target-shows-ws-172-x-x-x-or-pairing-errors-from-docker-cli" />[Gateway target shows ws://172.x.x.x or pairing errors from Docker CLI](/install/docker/sandbox-and-troubleshooting#gateway-target-shows-ws-172-x-x-x-or-pairing-errors-from-docker-cli)

## Related

- [Install Overview](/install) — all installation methods
- [Podman](/install/podman) — Podman alternative to Docker
- [Kubernetes](/install/kubernetes) — a minimal Kustomize starting point for running the Gateway on a cluster
- [Ansible](/install/ansible) — automated server deployment with Tailscale VPN and firewall isolation
- [Cloudflare Containers](/install/cloudflare) — experimental Worker plus container deployment with Litestream backups to R2
- [Updating](/install/updating) — keeping OpenClaw up to date
- [Configuration](/gateway/configuration) — Gateway configuration after install
