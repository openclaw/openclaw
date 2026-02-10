---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need to inspect raw model output for reasoning leakage（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want to run the Gateway in watch mode while iterating（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You need a repeatable debugging workflow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Debugging"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Debugging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page covers debugging helpers for streaming output, especially when a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
provider mixes reasoning into normal text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Runtime debug overrides（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/debug` is disabled by default; enable with `commands.debug: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is handy when you need to toggle obscure settings without editing `openclaw.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug show（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug set messages.responsePrefix="[openclaw]"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug unset messages.responsePrefix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/debug reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`/debug reset` clears all overrides and returns to the on-disk config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway watch mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For fast iteration, run the gateway under the file watcher:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:watch --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This maps to:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tsx watch src/entry.ts gateway --force（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add any gateway CLI flags after `gateway:watch` and they will be passed through（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on each restart.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Dev profile + dev gateway (--dev)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the dev profile to isolate state and spin up a safe, disposable setup for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
debugging. There are **two** `--dev` flags:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Global `--dev` (profile):** isolates state under `~/.openclaw-dev` and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults the gateway port to `19001` (derived ports shift with it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`gateway --dev`: tells the Gateway to auto-create a default config +（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  workspace** when missing (and skip BOOTSTRAP.md).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Recommended flow (dev profile + dev bootstrap):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:dev（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_PROFILE=dev openclaw tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you don’t have a global install yet, run the CLI via `pnpm openclaw ...`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
What this does:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Profile isolation** (global `--dev`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `OPENCLAW_PROFILE=dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas shift accordingly)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Dev bootstrap** (`gateway --dev`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Writes a minimal config if missing (`gateway.mode=local`, bind loopback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Sets `agent.workspace` to the dev workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Sets `agent.skipBootstrap=true` (no BOOTSTRAP.md).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Seeds the workspace files if missing:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Default identity: **C3‑PO** (protocol droid).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Skips channel providers in dev mode (`OPENCLAW_SKIP_CHANNELS=1`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reset flow (fresh start):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:dev:reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: `--dev` is a **global** profile flag and gets eaten by some runners.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you need to spell it out, use the env var form:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--reset` wipes config, credentials, sessions, and the dev workspace (using（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`trash`, not `rm`), then recreates the default dev setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: if a non‑dev gateway is already running (launchd/systemd), stop it first:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Raw stream logging (OpenClaw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can log the **raw assistant stream** before any filtering/formatting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is the best way to see whether reasoning is arriving as plain text deltas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(or as separate thinking blocks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enable it via CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:watch --force --raw-stream（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional path override:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Equivalent env vars:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_RAW_STREAM=1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.openclaw/logs/raw-stream.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Raw chunk logging (pi-mono)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
To capture **raw OpenAI-compat chunks** before they are parsed into blocks,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
pi-mono exposes a separate logger:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PI_RAW_STREAM=1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Optional path:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default file:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`~/.pi-mono/logs/raw-openai-completions.jsonl`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> Note: this is only emitted by processes using pi-mono’s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> `openai-completions` provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Raw stream logs can include full prompts, tool output, and user data.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep logs local and delete them after debugging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you share logs, scrub secrets and PII first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
