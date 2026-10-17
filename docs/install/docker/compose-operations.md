---
summary: "Day-to-day Compose commands, operational accordions, and image maintenance"
read_when:
  - You removed ClawDock and need the plain Compose commands
  - You hit EACCES, DNS, or rebuild problems
  - You want to know how the published images are refreshed
title: "Docker Compose operations and image maintenance"
sidebarTitle: "Compose operations"
---

The Compose command table that replaced ClawDock, the operational accordions, and how published images are refreshed. Part of the [Docker](/install/docker) guide.

## ClawDock migration

ClawDock has been removed. Use Docker Compose directly for day-to-day operations.
Existing copies downloaded with `curl` are not automatically uninstalled. Remove
the `source ~/.clawdock/clawdock-helpers.sh` line from your shell startup file
(`~/.zshrc` or `~/.bashrc`), then start a new shell. If you sourced a checkout copy
from `scripts/clawdock/` or the older `scripts/shell-helpers/` path, remove that
source line instead. Keep your OpenClaw state, credentials, workspace, project
`.env`, and volumes.

Run commands from the directory containing your `docker-compose.yml`. **Keep the
same Compose file set and order on every command** so mounts and settings remain
intact. With default file discovery, Compose loads `docker-compose.override.yml`
automatically when present. Extra and sandbox files need explicit `-f` options;
when using `-f`, include the standard override too if you use one. For example,
if your deployment uses all four files:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.extra.yml -f docker-compose.sandbox.yml ps
```

Use only the files your deployment already uses. The commands below show the
default file set; insert your existing `-f` options after `docker compose` when
needed. See [Manual flow](/install/docker#manual-flow) for setup and extra mounts.

| Task             | Command                                                            |
| ---------------- | ------------------------------------------------------------------ |
| Start            | `docker compose up -d openclaw-gateway`                            |
| Stop the stack   | `docker compose down`                                              |
| Restart          | `docker compose restart openclaw-gateway`                          |
| Container status | `docker compose ps`                                                |
| Follow logs      | `docker compose logs -f openclaw-gateway`                          |
| Gateway shell    | `docker compose exec openclaw-gateway bash`                        |
| CLI              | `docker compose run --rm openclaw-cli <command>`                   |
| Dashboard URL    | `docker compose run --rm openclaw-cli dashboard --no-open`         |
| List devices     | `docker compose run --rm openclaw-cli devices list`                |
| Approve a device | `docker compose run --rm openclaw-cli devices approve <requestId>` |
| Inspect config   | `docker compose run --rm openclaw-cli config get <path>`           |

Start the gateway before using the shell or CLI commands. For a custom host port,
adjust the printed dashboard URL as described in [Containerized Gateway](/install/docker#containerized-gateway).
Use [Health checks](/install/docker#health-checks) to verify the gateway and
[Update OpenClaw](/install/docker-vm-runtime#update-openclaw) for image updates.

When the CLI shares Gateway state, add `pid: "service:openclaw-gateway"` to the
`openclaw-cli` service in your Compose override so ownership checks can see the
Gateway's processes; sharing the network alone does not share the PID namespace.
Alternatively, run the TUI inside the Gateway container with
`docker compose exec openclaw-gateway openclaw tui`. A different PID namespace
now refuses unverifiable ownership instead of reclaiming the running Gateway's
lock. `tui --local` starts an embedded agent and is not a PID-namespace workaround
for shared state. Older locks retain their previous recovery behavior until the
Gateway next starts and writes namespace identity.
A replacement Gateway reclaims a crashed container's state lock and SQLite owner
lease after about 90 seconds without an owner heartbeat, even when Docker assigns
a different hostname. Startup waits up to 95 seconds for fresh ownership evidence
to age out. Doctor refuses a fresh, unverifiable owner immediately; after stopping
the previous Gateway, wait up to 90 seconds after its last heartbeat and retry.
Existing leases from older images use their recorded hostname and heartbeat until
the replacement publishes boot and PID namespace identity. A verified live owner
still blocks takeover, even when its lease deadline has passed. Image updates need
no schema migration or manual lease deletion.

Token setup belongs to the [Docker setup flow](/install/docker#containerized-gateway).
If you need the Control UI token, read `OPENCLAW_GATEWAY_TOKEN` privately from the
project `.env`. [`config get <path>`](/cli/config) redacts sensitive values; it
does not reveal the full token.

<AccordionGroup>
  <Accordion title="Enable agent sandbox for Docker gateway">
    ```bash
    export OPENCLAW_SANDBOX=1
    ./scripts/docker/setup.sh
    ```

    Custom socket path (e.g. rootless Docker):

    ```bash
    export OPENCLAW_SANDBOX=1
    export OPENCLAW_DOCKER_SOCKET=/run/user/1000/docker.sock
    ./scripts/docker/setup.sh
    ```

    The script mounts `docker.sock` only after sandbox prerequisites pass. If sandbox setup can't complete, it resets `agents.defaults.sandbox.mode` to `off`. Codex code mode is disabled for turns where the OpenClaw sandbox is active (see [Sandboxing § Docker backend](/gateway/sandboxing#docker-backend)); never mount the host Docker socket into agent sandbox containers.

  </Accordion>

  <Accordion title="Automation / CI (non-interactive)">
    Disable Compose pseudo-TTY allocation with `-T`:

    ```bash
    docker compose run -T --rm openclaw-cli gateway probe
    docker compose run -T --rm openclaw-cli devices list --json
    ```

  </Accordion>

  <Accordion title="Shared-network security note">
    `openclaw-cli` uses `network_mode: "service:openclaw-gateway"` so CLI commands can reach the gateway over `127.0.0.1`. Treat this as a shared trust boundary. The compose config drops `NET_RAW`/`NET_ADMIN` and enables `no-new-privileges` on both `openclaw-gateway` and `openclaw-cli`.
  </Accordion>

  <Accordion title="Docker Desktop DNS failures in openclaw-cli">
    Some Docker Desktop setups fail DNS lookups from the shared-network `openclaw-cli` sidecar after `NET_RAW` is dropped, showing up as `EAI_AGAIN` during npm-backed commands like `openclaw plugins install`. Keep the default hardened compose file for normal operation. The override below restores default capabilities for the `openclaw-cli` container only — use it for the one-off command that needs registry access, not as your default invocation:

    ```bash
    printf '%s\n' \
      'services:' \
      '  openclaw-cli:' \
      '    cap_drop: !reset []' \
      > docker-compose.cli-no-dropped-caps.local.yml

    docker compose -f docker-compose.yml -f docker-compose.cli-no-dropped-caps.local.yml run --rm openclaw-cli plugins install <package>
    ```

    If you already created a long-running `openclaw-cli` container, recreate it with the same override — `docker compose exec`/`docker exec` can't change Linux capabilities on an already-created container.

  </Accordion>

  <Accordion title="Permissions and EACCES">
    The container runs as uid 1000 by default (the image's `node` user). If you see permission errors on `/home/node/.openclaw`, pick the branch that matches your host storage:

    **You control the host directories** (local disk, most VPS/root-accessible setups) — chown them to match the container default:

    ```bash
    sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
    ```

    **You cannot change the ownership** (shared storage, an owner you don't control, a uid policy you can't change) — set `OPENCLAW_PUID`/`OPENCLAW_PGID` in `.env` to the directory's own uid/gid instead. `scripts/docker/setup.sh` validates and persists these (decimal only, `0` rejected, max `65533`); both `openclaw-gateway` and `openclaw-cli` pick them up from `.env` on the next `docker compose up -d`. See [Running as a different uid](#running-as-a-different-uid) for the full recipe and its limitations.

    The same mismatch can show up as `blocked plugin candidate: suspicious ownership (... uid=1000, expected uid=0 or root)` followed by `plugin present but blocked` — the process uid and the mounted plugin directory owner disagree; apply whichever branch above matches your storage. Only chown `/path/to/openclaw-config/npm` to `root:root` if you intentionally run OpenClaw as root long term.

  </Accordion>

  <Accordion title="Faster rebuilds">
    Use the repo-root `Dockerfile` instead of replacing it with a shortened
    single-stage example. Its `workspace-deps` stage extracts the package
    manifests required by `pnpm-workspace.yaml`. Build and production dependency
    stages share those inputs and run separate frozen-lockfile installs. This
    keeps both dependency layers cacheable without omitting `packages/*`, selected
    `extensions/*`, or other required workspace metadata.

    The `runtime-assets` stage inherits `production-deps` and overlays `/app`
    from `runtime-build-output`, a copy of `build` with dependency trees removed.
    This reuses the fresh production install's layers while preserving compiled
    workspace packages and native addon outputs. It does not run `pnpm prune`
    on dependencies inherited from an image layer; pnpm 12 can fail that operation
    with `EXDEV` on OverlayFS. The `build` target retains development dependencies
    for live-test containers.

    The same Dockerfile preserves the production runtime contract: digest-pinned
    Node and Bun bases, a non-root user (uid 1000 by default), `tini`, the built-in health check, and
    the `/usr/local/bin/openclaw` symlink. Dependabot refreshes the reviewed base
    digests; do not replace them with floating `FROM node:24-bookworm` tags.

  </Accordion>

  <Accordion title="Power-user container options">
    The default image is security-first and runs as non-root `node`. For a more full-featured container:

    1. **Persist `/home/node`**: `export OPENCLAW_HOME_VOLUME="openclaw_home"`
    2. **Bake system deps**: `export OPENCLAW_IMAGE_APT_PACKAGES="git curl jq"`
    3. **Bake Python deps**: `export OPENCLAW_IMAGE_PIP_PACKAGES="requests==2.32.5 humanize==4.14.0"`
    4. **Bake Playwright Chromium**: `export OPENCLAW_INSTALL_BROWSER=1`, or use the official `-browser` image tag
    5. **Persist browser downloads and caches**: use `OPENCLAW_HOME_VOLUME` or `OPENCLAW_EXTRA_MOUNTS`. OpenClaw auto-detects the image's Playwright-managed Chromium on Linux.

  </Accordion>

  <Accordion title="OpenAI Codex OAuth (headless Docker)">
    If you pick OpenAI Codex OAuth in the wizard, it opens a browser URL. In Docker or headless setups, copy the full redirect URL you land on and paste it back into the wizard to finish auth.
  </Accordion>

  <Accordion title="Base image metadata">
    The runtime image uses `node:24-bookworm-slim` and runs `tini` as PID 1 so zombie processes are reaped and signals handled correctly in long-running containers. It publishes OCI base-image annotations including `org.opencontainers.image.base.name` and `org.opencontainers.image.source`. Dependabot refreshes the pinned Node base digest, and each build applies current Debian point-release updates. See [OCI image annotations](https://github.com/opencontainers/image-spec/blob/main/annotations.md).
  </Accordion>
</AccordionGroup>

## Running as a different uid

Docker bind mounts carry ownership numerically: the container sees the host's
uid and gid, never its user names. A write succeeds only when the container's
uid owns the mounted directory, or reaches it through its gid. The image runs
as uid 1000, so any host whose directories belong to a different uid runs into
this — a Linux account that happens to be uid 1001, a CI runner, an LDAP or
NFS-mapped home directory, or network-attached storage.

The usual fix is to chown the host directories to `1000:1000`. When you cannot
— shared storage, an owner you do not control, or a uid policy you cannot
change — set `OPENCLAW_PUID`/`OPENCLAW_PGID` instead. Both `openclaw-gateway`
and `openclaw-cli` run as `"${OPENCLAW_PUID:-1000}:${OPENCLAW_PGID:-1000}"`, so
leaving them unset reproduces the previous default byte for byte, and the
Gateway refuses to start if you set `OPENCLAW_PUID=0` — root is never allowed.

### Find the uid and gid

Run `stat -c '%u %g' /path/to/openclaw-config` on the mounted directory itself,
or `id <user>` for the account that owns it. If you cannot get a shell on the
host, start the container once with the defaults and run `openclaw doctor`.
On an ownership mismatch it prints `Owner mismatch (uid N)`, where `N` is the
uid that owns the mounted directory; use it as `OPENCLAW_PUID` (the `chown`
command in the same hint targets the container's current uid instead). Restart
with that uid and run `openclaw doctor` again: a `Group mismatch (gid N)` hint
names the directory's gid for `OPENCLAW_PGID`, and no hint means the gid
already works.

With `scripts/docker/setup.sh`, put them in the environment and the script
validates them (decimal only, `0` rejected, max `65533`) and writes them to
`.env`. Without the script, set them in `.env` directly or in the compose file
you deploy.

### Example: a GUI container manager with no shell access

Some hosts only expose a compose editor — a NAS appliance such as Synology's
Container Manager is the common case. The recipe below is self-contained: it
pulls the published image, needs no repo checkout, and hard-codes the values
that the repo's own `docker-compose.yml` would otherwise read from `.env`.

Replace `1026:100` with your own uid:gid, `/volume1/docker/openclaw/...` with
your own directory paths, `REPLACE_WITH_A_LONG_RANDOM_TOKEN` with a real token,
and `<host-ip>` with the LAN IP or hostname you will browse to. Pre-create the
three host directories and chown them to your uid:gid before starting — the
container cannot create top-level bind-mount directories it does not own.
All three must be mounted: the auth-profile secret directory holds credentials
that would otherwise be lost every time the container is replaced.

```yaml
services:
  openclaw-gateway:
    image: ghcr.io/openclaw/openclaw:latest
    user: "1026:100" # replace with the output of `id <user>`
    environment:
      HOME: /home/node
      OPENCLAW_HOME: /home/node
      XDG_CACHE_HOME: /home/node/.openclaw/cache
      NPM_CONFIG_CACHE: /home/node/.openclaw/.npm
      OPENCLAW_PUID: "1026" # lets the Gateway refuse an accidental OPENCLAW_PUID=0
      OPENCLAW_STATE_DIR: /home/node/.openclaw
      OPENCLAW_CONFIG_PATH: /home/node/.openclaw/openclaw.json
      OPENCLAW_CONFIG_DIR: /home/node/.openclaw
      OPENCLAW_WORKSPACE_DIR: /home/node/.openclaw/workspace
      OPENCLAW_GATEWAY_PORT: "18789"
      OPENCLAW_GATEWAY_TOKEN: "REPLACE_WITH_A_LONG_RANDOM_TOKEN"
    volumes:
      - /volume1/docker/openclaw/config:/home/node/.openclaw
      - /volume1/docker/openclaw/workspace:/home/node/.openclaw/workspace
      - /volume1/docker/openclaw/auth-profile-secrets:/home/node/.config/openclaw
    ports:
      - "18789:18789"
    command: ["node", "dist/index.js", "gateway", "--bind", "lan", "--port", "18789"]
    cap_drop:
      - NET_RAW
      - NET_ADMIN
    security_opt:
      - no-new-privileges:true
    init: true
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "dist/docker-healthcheck.js"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 20s
```

On first boot, run the same onboarding and config-set commands as the
[manual flow](/install/docker#manual-flow), substituting your project's
service name for `openclaw-gateway`. Include
`gateway.controlUi.allowedOrigins` in that config-set call, or add it
afterwards:

```bash
docker compose exec openclaw-gateway node dist/index.js \
  config set gateway.controlUi.allowedOrigins '["http://<host-ip>:18789"]'
```

### Reaching the Control UI from another host

`--bind lan` publishes the gateway on the LAN. The Gateway refuses a
non-loopback bind unless a shared secret is configured —
`OPENCLAW_GATEWAY_TOKEN` above satisfies that — and separately refuses a
non-loopback Control UI unless `gateway.controlUi.allowedOrigins` lists the
origins you'll browse from, which is why the config-set call above is
required before you can open the Control UI at `http://<host-ip>:18789/`.

<Warning>
A directory exposed as world-writable (`chmod 777`) is rejected outright for
non-bundled plugins — don't "fix" a permissions error that way. Chown to the
correct uid/gid instead.
</Warning>

### Limitations

- **The ssh sandbox backend and node pairing over ssh don't work at a custom uid.** `ssh` refuses to run for a uid with no `/etc/passwd` entry (`No user exists for uid <N>`), so both are unavailable once `OPENCLAW_PUID` is anything other than 1000. The image still installs `openssh-client` for the sandbox backend on the default uid.
- **Named volumes need a one-off ownership repair.** If you use `OPENCLAW_HOME_VOLUME`, repair its ownership once after first start:

  ```bash
  docker compose run --rm --user root --entrypoint sh openclaw-gateway -c 'chown -R <PUID>:<PGID> /home/node/.openclaw'
  ```

- **Changing the uid on an existing install** needs a host-side `chown -R` of the bind mounts to the new uid/gid first. Otherwise previously installed (non-bundled) plugins fail the ownership gate and get blocked.
- **Kubernetes ignores these variables.** The [Kubernetes manifests](/install/kubernetes) pin `runAsUser`/`runAsGroup` directly; `OPENCLAW_PUID`/`OPENCLAW_PGID` only apply to this Docker Compose setup.
- **Docker userns-remap or rootless Docker changes the host-side owner** of files the container writes, which changes what you'd need to chown. These instructions assume a normal, non-remapped Docker daemon.
- **Don't set `agents.defaults.sandbox.docker.user`.** OpenClaw already derives the agent sandbox container's user from the workspace owner; pinning it yourself disables that detection.

See [Storage and persistence](/install/docker/networking-and-storage#storage-and-persistence) for what else the mounted config directory holds.

## Image contents and security scanning

Runtime images contain production Node.js dependencies only. Release builds pin the base image by digest and apply current Debian security updates with `apt-get dist-upgrade`; the `-browser` variant installs the Chromium version pinned by its Playwright release.

Scanner totals can include Debian findings that the distribution marks `wont-fix`. To rebuild locally against current base and package metadata, run `docker build --pull -t openclaw:local .`.

## Weekly image refreshes

The `latest*`, `main*`, and `extended-stable*` moving tags are rebuilt weekly from the same tagged release source so they pick up current OS security updates between OpenClaw releases. Stable and extended-stable refreshes remain separate, and beta images are not rebuilt on this schedule.

Each refresh also publishes a dated tag such as `2026.8.1-r20260820` (plus `-slim` and `-browser` variants). Plain version tags and dated `-rYYYYMMDD` tags are immutable; pin either form when you do not want a deployment to follow a moving tag.

## Running on a VPS?

See [Hetzner (Docker VPS)](/install/hetzner) and [Docker VM Runtime](/install/docker-vm-runtime) for shared VM deployment steps including binary baking, persistence, and updates.
