---
summary: "Bun-workflow (eksperimentel): installation og faldgruber vs pnpm"
read_when:
  - Du vil have den hurtigste lokale udviklingsloop (bun + watch)
  - Du støder på problemer med Bun install/patch/lifecycle-scripts
title: "Bun (Eksperimentel)"
x-i18n:
  source_path: install/bun.md
  source_hash: eb3f4c222b6bae49
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:17Z
---

# Bun (eksperimentel)

Mål: kør dette repo med **Bun** (valgfrit, ikke anbefalet til WhatsApp/Telegram)
uden at afvige fra pnpm-workflows.

⚠️ **Ikke anbefalet til Gateway-runtime** (WhatsApp/Telegram-fejl). Brug Node i produktion.

## Status

- Bun er et valgfrit lokalt runtime til at køre TypeScript direkte (`bun run …`, `bun --watch …`).
- `pnpm` er standard for builds og forbliver fuldt understøttet (og bruges af noget docs-værktøj).
- Bun kan ikke bruge `pnpm-lock.yaml` og vil ignorere det.

## Installér

Standard:

```sh
bun install
```

Bemærk: `bun.lock`/`bun.lockb` er gitignored, så der er ingen repo-ændringer uanset hvad. Hvis du vil have _ingen lockfile-skrivninger_:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle-scripts (blokeret som standard)

Bun kan blokere afhængigheders lifecycle-scripts, medmindre de eksplicit er betroet (`bun pm untrusted` / `bun pm trust`).
For dette repo er de ofte blokerede scripts ikke nødvendige:

- `@whiskeysockets/baileys` `preinstall`: tjekker Node major >= 20 (vi kører Node 22+).
- `protobufjs` `postinstall`: udsender advarsler om inkompatible versionsskemaer (ingen build-artifakter).

Hvis du rammer et reelt runtime-problem, der kræver disse scripts, så betro dem eksplicit:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Forbehold

- Nogle scripts hardcoder stadig pnpm (fx `docs:build`, `ui:*`, `protocol:check`). Kør dem via pnpm indtil videre.
