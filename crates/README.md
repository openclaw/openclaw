# OpenClaw (Rust)

A native Rust implementation of the [OpenClaw](https://github.com/openclaw/openclaw)
Gateway: WebSocket control plane, SQLite state, DM pairing, channels, model
providers, skills, and a Control UI.

> **Status: partial prototype, not a drop-in replacement.** This is an
> in-progress rewrite, not a finished product. Some documented OpenClaw features
> are implemented and tested; many are missing. Every gap is listed in
> [`crates/parity-commands.tsv`](crates/parity-commands.tsv) and
> [`crates/PARITY.md`](crates/PARITY.md), and the build **fails** if that table
> disagrees with the binary. Do not read "it compiles" or "the command exists" as
> feature parity.

## What works today

| Area | State |
|---|---|
| Gateway WebSocket server, protocol v4 handshake (`connect.challenge`, `minProtocol`/`maxProtocol`, full `hello-ok`) | implemented, tested |
| Operator scope authorization (`operator.read/write/admin` + named scopes) | implemented, tested |
| Shared-token / password authentication, constant-time compare, WS `Origin` check | implemented, tested |
| `tick` / `shutdown` events, session persistence across restart | implemented, tested |
| SQLite state (sessions, messages, replies, pairings, memories, cron rows) | implemented, tested |
| DM pairing (8-char codes, 1 h expiry, 3-pending cap, account scoping, dismiss) | implemented, tested |
| Control UI (web chat, sessions, skills, channels, pairing, API list) | implemented, tested |
| `config` get/set/patch/unset/file/schema/validate, `--dry-run`, read-only mode | implemented, tested |
| `uninstall` (service/state/workspace/app/all, dry-run) | implemented, tested |
| `gateway install/uninstall` (systemd unit / launchd plist) | implemented, text-tested only |
| `gateway status --json` with `service.loaded` | implemented, tested |
| Telegram channel (polling, pairing, commands), Discord/Slack/webhook outbound | partial |
| Native providers (Anthropic, OpenAI, Ollama) + OpenAI-compatible presets | partial |
| Skills discovery (`SKILL.md`) and prompt augmentation | partial |

## What does not work yet

These are **absent**, not merely rough:

- The official Control UI bundle. This build serves its own HTML on a separate
  port (18790) over an HTTP API, not the Gateway WS protocol, so
  `dist/control-ui` cannot attach.
- The one-time owner pairing handoff (`openclaw dashboard` reports
  `pairing_handoff_unavailable` instead of faking it).
- Device/node pairing end to end: no `devices`, `nodes`, `qr`, setup codes,
  bootstrap tokens, or device tables.
- `gateway start|stop|restart`, `daemon`, `backup`, `restore`, `update`,
  `plugins`, `agents`, `sessions`, `logs`, `health`, `status`, `models`,
  `channels`, `security`, `secrets`, `sandbox`, `approvals`, `mcp`, `acp`,
  `hooks`, `webhooks`, `message`, `infer`, `tui`, `completion`.
- `doctor --fix`, config migrations, `commands.ownerAllowFrom`, plugin runtime,
  cron scheduling (rows are stored and listed, nothing executes them).
- A published installer or release artifact. There is no `openclaw.ai/install.sh`
  equivalent for this build.

## Repository layout

```
crates/
  openclaw-core/        ids, messages, sessions, traits
  openclaw-config/      schema, path resolution, auth policy, validation
  openclaw-protocol/    wire frames, protocol v4, method/scope table
  openclaw-gateway/     WS server, handshake, dispatch, authorization
  openclaw-dashboard/   Control UI HTTP server and HTML
  openclaw-channels/    Telegram, Discord, HTTP webhook adapters
  openclaw-llm/         provider adapters
  openclaw-state/       SQLite store (sessions, transcripts, pairings)
  openclaw-skills/      SKILL.md discovery and prompt blocks
  openclaw-cli/         the `openclaw` binary
  openclaw-gateway-client/, openclaw-node-host/   pre-existing client + node host
  parity-commands.tsv   documented command surface vs. this build
  PARITY.md             evidence ledger, open defects, proof gaps
```

## Build

Requires Rust 1.93+.

```bash
cd crates
cargo build --release --locked -p openclaw-cli -p openclaw-node-host
```

Binaries land in `crates/target/release/`:

- `openclaw` — CLI and Gateway
- `openclaw-node` — node host

## Quick start

```bash
# 1. Create config (generates a gateway token, binds loopback)
./target/release/openclaw onboard

# 2. Run the Gateway in the foreground
./target/release/openclaw gateway
```

`onboard` writes `openclaw.json` into the state directory and prints where it
went. Reuse the generated token when a client asks for one:

```bash
./target/release/openclaw config get gateway.auth.token
```

Set a model key before chatting:

```bash
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY
```

## Documentation

- [`README.md`](README.md) — what this is, what works, what does not.
- [`docs/INSTALL.md`](docs/INSTALL.md) — installation, service setup, ARM64,
  containers, and what is not supported.
- [`docs/UPDATE.md`](docs/UPDATE.md) — updating, verifying, and rolling back.
  **There is no self-update command.**
- [`docs/COMMANDS.md`](docs/COMMANDS.md) — every command, flag, exit code, and
  the exact list of unimplemented commands.
- [`PARITY.md`](PARITY.md) — evidence ledger: what was compared against which
  upstream reference, which defects were found and fixed, and what remains
  unproven.

## Verification

```bash
cd crates
cargo build --workspace --offline     # 0 warnings
cargo test  --workspace --offline     # 63 suites, 311 tests
```

Tests use isolated temporary state directories and ephemeral ports; they never
touch a real `~/.openclaw` installation.

## Compatibility notes

- **Config paths** follow the documented precedence: `OPENCLAW_CONFIG_PATH`,
  then `$OPENCLAW_STATE_DIR/openclaw.json`, with `OPENCLAW_HOME` and `HOME`
  (or `USERPROFILE`) fallbacks.
- **Credentials** come from `gateway.auth.token` / `gateway.auth.password` or
  `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD`. Config wins.
- **Upstream state is not readable.** This build uses its own `pairings` and
  `sessions` tables, not upstream's `channel_pairing_requests` /
  `channel_pairing_allow_entries` in `~/.openclaw/state/openclaw.sqlite`. There
  is no import path yet.
- **Linux ARM64 has not been built or run here.** See `docs/INSTALL.md`.

## License

MIT, matching upstream.
