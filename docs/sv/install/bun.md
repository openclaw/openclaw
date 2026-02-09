---
summary: "Bun-arbetsflöde (experimentellt): installationer och fallgropar jämfört med pnpm"
read_when:
  - Du vill ha den snabbaste lokala utvecklingsloopen (bun + watch)
  - Du stöter på problem med Bun install/patch/livscykelskript
title: "Bun (experimentellt)"
---

# Bun (experimentellt)

Mål: köra detta repo med **Bun** (valfritt, rekommenderas inte för WhatsApp/Telegram)
utan att avvika från pnpm-arbetsflöden.

⚠️ **Rekommenderas inte för Gateway runtime** (WhatsApp/Telegram buggar). Använd nod för produktion.

## Status

- Bun är en valfri lokal runtime för att köra TypeScript direkt (`bun run …`, `bun --watch …`).
- `pnpm` är standard för byggen och förblir fullt stödd (och används av viss dokumentationsverktyg).
- Bun kan inte använda `pnpm-lock.yaml` och kommer att ignorera den.

## Installera

Standard:

```sh
bun install
```

Notera: `bun.lock`/`bun.lockb` är gitignorerade, så det finns ingen repo churn i alla fall. Om du vill ha _inga låsfilsskrivningar_:

```sh
bun install --no-save
```

## Bygg / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun-livscykelskript (blockerade som standard)

Bun kan blockera beroenden livscykelskript om inte uttryckligen betrodda (`bun pm untrusted` / `bun pm trust`).
För detta repo, är de ofta blockerade skript inte nödvändiga:

- `@whiskeysockets/baileys` `preinstall`: kontrollerar Node major >= 20 (vi kör Node 22+).
- `protobufjs` `postinstall`: skickar varningar om inkompatibla versionsscheman (inga byggartefakter).

Om du stöter på ett verkligt körtidsproblem som kräver dessa skript, betro dem uttryckligen:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Förbehåll

- Vissa skript fortfarande hårdkod pnpm (t.ex. `docs:build`, `ui:*`, `protocol:check`). Kör dem via pnpm för tillfället.
