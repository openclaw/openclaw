---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Bun workflow (experimental): installs and gotchas vs pnpm"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You want the fastest local dev loop (bun + watch)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - You hit Bun install/patch/lifecycle script issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Bun (Experimental)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Bun (experimental)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: run this repo with **Bun** (optional, not recommended for WhatsApp/Telegram)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
without diverging from pnpm workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
⚠️ **Not recommended for Gateway runtime** (WhatsApp/Telegram bugs). Use Node for production.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bun is an optional local runtime for running TypeScript directly (`bun run …`, `bun --watch …`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm` is the default for builds and remains fully supported (and used by some docs tooling).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bun cannot use `pnpm-lock.yaml` and will ignore it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bun install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: `bun.lock`/`bun.lockb` are gitignored, so there’s no repo churn either way. If you want _no lockfile writes_:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bun install --no-save（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build / Test (Bun)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bun run build（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bun run vitest run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Bun lifecycle scripts (blocked by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Bun may block dependency lifecycle scripts unless explicitly trusted (`bun pm untrusted` / `bun pm trust`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For this repo, the commonly blocked scripts are not required:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `@whiskeysockets/baileys` `preinstall`: checks Node major >= 20 (we run Node 22+).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `protobufjs` `postinstall`: emits warnings about incompatible version schemes (no build artifacts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you hit a real runtime issue that requires these scripts, trust them explicitly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bun pm trust @whiskeysockets/baileys protobufjs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Caveats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Some scripts still hardcode pnpm (e.g. `docs:build`, `ui:*`, `protocol:check`). Run those via pnpm for now.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
