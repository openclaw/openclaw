---
summary: "Bun-arbetsflöde (experimentellt): installationer och fallgropar jämfört med pnpm"
read_when:
  - Du vill ha den snabbaste lokala utvecklingsloopen (bun + watch)
  - Du stöter på problem med Bun install/patch/livscykelskript
title: "Bun (experimentellt)"
x-i18n:
  source_path: install/bun.md
  source_hash: eb3f4c222b6bae49
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:37Z
---

# Bun (experimentellt)

Mål: köra detta repo med **Bun** (valfritt, rekommenderas inte för WhatsApp/Telegram)
utan att avvika från pnpm-arbetsflöden.

⚠️ **Rekommenderas inte för Gateway-körtid** (buggar i WhatsApp/Telegram). Använd Node i produktion.

## Status

- Bun är en valfri lokal runtime för att köra TypeScript direkt (`bun run …`, `bun --watch …`).
- `pnpm` är standard för byggen och förblir fullt stödd (och används av viss dokumentationsverktyg).
- Bun kan inte använda `pnpm-lock.yaml` och kommer att ignorera den.

## Installera

Standard:

```sh
bun install
```

Obs: `bun.lock`/`bun.lockb` är gitignorerade, så det blir ingen repo-churn oavsett. Om du vill ha _inga skrivningar till lockfiler_:

```sh
bun install --no-save
```

## Bygg / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun-livscykelskript (blockerade som standard)

Bun kan blockera beroendenas livscykelskript om de inte uttryckligen betros (`bun pm untrusted` / `bun pm trust`).
För detta repo krävs de vanligast blockerade skripten inte:

- `@whiskeysockets/baileys` `preinstall`: kontrollerar Node major >= 20 (vi kör Node 22+).
- `protobufjs` `postinstall`: skickar varningar om inkompatibla versionsscheman (inga byggartefakter).

Om du stöter på ett verkligt körtidsproblem som kräver dessa skript, betro dem uttryckligen:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Förbehåll

- Vissa skript hårdkodar fortfarande pnpm (t.ex. `docs:build`, `ui:*`, `protocol:check`). Kör dem via pnpm tills vidare.
