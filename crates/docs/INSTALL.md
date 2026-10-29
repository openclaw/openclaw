# Installation

This guide covers installing the Rust build from source. There is **no published
installer, package, or release artifact** for this build — the official
`openclaw.ai/install.sh` one-liner installs the Node product, not this one.

Read [`../README.md`](../README.md) first: this is a partial prototype, and the
feature list matters more than the install steps.

## Requirements

| Requirement | Detail |
|---|---|
| Rust | 1.93 or newer (`rustc --version`) |
| OS | Linux, macOS, or Windows. Linux is the primary target. |
| Disk | ~2 GB for `target/` during a release build |
| Network | Needed once for `cargo` dependencies, unless you vendor them |

No Node.js, npm, pnpm, or Bun is required — this is a native binary.

## Build from source

```bash
git clone <this repository>
cd openclaw/crates
cargo build --release --locked -p openclaw-cli -p openclaw-node-host
```

Output:

```
crates/target/release/openclaw        # CLI + Gateway
crates/target/release/openclaw-node   # node host
```

Verify:

```bash
./target/release/openclaw version
./target/release/openclaw help
```

`cargo build` emits zero warnings on a clean tree. If you see warnings, the tree
was modified.

## First-run setup

```bash
./target/release/openclaw onboard
```

What it does:

1. Resolves the config path using the documented precedence:
   `OPENCLAW_CONFIG_PATH` → `$OPENCLAW_STATE_DIR/openclaw.json` →
   `$OPENCLAW_HOME/.openclaw/openclaw.json` → `$HOME/.openclaw/openclaw.json`.
2. Creates the state directory if missing.
3. Writes `openclaw.json` with `gateway.mode: "local"`, `listen:
   "127.0.0.1:18789"`, `requireAuth: true`, and a freshly generated
   `gateway.auth.token`.
4. Points `database.path` at `openclaw.db` inside the state directory.

It is idempotent: if the config exists, onboarding leaves it alone.

Flags:

| Flag | Effect |
|---|---|
| `--install-daemon` | Install the Gateway service after writing config. Fails loudly if no service manager exists. |
| `--no-install-daemon`, `--skip-daemon` | Explicit skip (the default). |
| `--config <path>` | Reserved for a config override. |

Unknown flags exit `2` rather than being ignored.

## Running the Gateway

Foreground:

```bash
./target/release/openclaw gateway
```

With explicit overrides:

```bash
./target/release/openclaw gateway run \
  --config /etc/openclaw/openclaw.json \
  --port 18789 \
  --bind 127.0.0.1 \
  --token "$OPENCLAW_GATEWAY_TOKEN"
```

Recognized flags: `--config`, `--listen`, `--port`, `--bind`, `--token`,
`--password`, `--dashboard`, `--verbose`, `--dev`. Anything else exits non-zero —
`--port` and `--token` are never silently dropped.

`--force` and `--reset` are **not implemented** and exit non-zero.

The Gateway refuses to start when authentication is required but no usable secret
resolves, and when `gateway.listen` is non-loopback with `auth.mode: "none"`.

## Configuration

Edit `openclaw.json` directly, or use the CLI:

```bash
openclaw config file                      # active path
openclaw config get gateway.listen
openclaw config set logging.level debug   # JSON-typed: true/64 become bool/number
openclaw config patch '{"logging":{"json":true}}'
openclaw config unset logging.level
openclaw config validate                  # exits non-zero on problems
openclaw config schema                    # supported top-level keys
```

`--dry-run` prints the planned change without writing. Writes go through a temp
file and rename, so a crash cannot truncate live config.

### Read-only config

Set `OPENCLAW_CONFIG_READONLY=1` (or `OPENCLAW_NIX_MODE=1`) for both the Gateway
and the CLI when a deployment system owns the file. Read commands still work;
`config set`/`patch`/`unset` refuse.

### Credentials

| Mode | Config | Environment |
|---|---|---|
| token | `gateway.auth.token` | `OPENCLAW_GATEWAY_TOKEN` |
| password | `gateway.auth.password` | `OPENCLAW_GATEWAY_PASSWORD` |
| none | `gateway.auth.mode: "none"` | — (loopback only) |

An explicit config value wins over the environment. `trusted-proxy` is **not
implemented**; it fails closed rather than becoming open access.

## Installing as a service

```bash
sudo ./target/release/openclaw gateway install          # system unit
./target/release/openclaw gateway install --user        # user unit
```

The command writes the definition, then **activates it** (`systemctl enable
--now` / `launchctl bootstrap`). If activation fails, the command exits non-zero
and tells you the exact command to run.

| Platform | Definition |
|---|---|
| Linux | `/etc/systemd/system/openclaw-gateway.service` (or `~/.config/systemd/user/…` with `--user`) |
| macOS | `~/Library/LaunchAgents/ai.openclaw.gateway.plist` |

Remove it:

```bash
openclaw gateway uninstall
```

This also removes the legacy `clawdbot-gateway.service` if present.

Check status:

```bash
openclaw gateway status          # human output
openclaw gateway status --json   # {"service":{"loaded":…},"gateway":{"reachable":…}}
```

`--json` exits `0` only when the Gateway is reachable (or `--no-probe` with a
loaded service), so scripts can branch.

## Linux ARM64 (aarch64)

An installer script is provided at `crates/install-linux-arm64.sh`:

```bash
./install-linux-arm64.sh --prefix /usr/local --state-dir /var/lib/openclaw
```

It builds natively for the detected architecture (`aarch64`/`arm64` or
`x86_64`/`amd64`), installs the binaries, copies skills, runs onboarding if no
config exists, and delegates service installation to
`openclaw gateway install`. Unsupported architectures exit `1`.

Flags: `--prefix <dir>`, `--state-dir <dir>`, `--user`, `--dry-run`.

**This script has not been executed on ARM64 in this repository's environment.**
The host used for development has no ARM64 target installed and WSL is disabled,
so ARM64 is unverified. Treat it as untested tooling, not a supported platform
claim.

To build manually for ARM64:

```bash
rustup target add aarch64-unknown-linux-gnu
cargo build --release --locked --target aarch64-unknown-linux-gnu -p openclaw-cli
```

You need a cross-linker (`gcc-aarch64-linux-gnu`) for that target.

## Containers

`crates/Dockerfile.arm64` builds for `arm64` and `amd64`:

```bash
docker build -f Dockerfile.arm64 -t openclaw-rust .
docker run --rm -p 18789:18789 -p 18790:18790 \
  -v openclaw-state:/var/lib/openclaw \
  -e OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
  openclaw-rust
```

The entrypoint (`crates/entrypoint.sh`) runs onboarding on first start so a config
exists inside the mounted volume, then execs the Gateway. State lives on
`/var/lib/openclaw`; the database path is pinned there by onboarding.

A non-loopback listener without `OPENCLAW_GATEWAY_TOKEN` fails at startup by
design. That is intentional: the container must not serve an open control plane.

## Uninstalling

```bash
openclaw uninstall --dry-run                    # show the plan
openclaw uninstall --service --yes              # remove the service only
openclaw uninstall --state --yes                # config + state, keeps workspaces
openclaw uninstall --state --workspace --yes    # also remove workspaces
openclaw uninstall --all --yes --non-interactive
```

| Flag | Effect |
|---|---|
| `--service` | Remove service definitions (official + legacy names) |
| `--state` | Remove config and state; **preserves** workspace directories |
| `--workspace` | Remove workspace directories (also removes configured ones) |
| `--app` | macOS app; reports "not applicable" elsewhere |
| `--all` | All four scopes |
| `--yes` | Skip confirmation |
| `--non-interactive` | No prompts; requires `--yes` |
| `--dry-run` | Print the plan, remove nothing |

State removal refuses when a Gateway appears to own the directory.

**There is no `openclaw backup`.** Take your own copy before `--state`:

```bash
tar -czf openclaw-state-$(date +%F).tar.gz -C "$HOME" .openclaw
```

## Not supported

These official installation paths have no equivalent here:

- `curl https://openclaw.ai/install.sh | bash`
- `install-cli.sh` rootless prefix flow, `install.ps1`, FreeBSD
- Node/Bun runtime provisioning and version gating
- `--install-method npm|git`, `--version`, `--beta`, `--git-dir`, `--verify`
- Windows Hub, macOS `.dmg`, Tauri installer
- `doctor --fix` migrations after an upgrade

See [`COMMANDS.md`](COMMANDS.md) for the full unimplemented list.
