---
summary: "Bun-workflow (experimenteel): installatie en aandachtspunten vs pnpm"
read_when:
  - Je wilt de snelste lokale ontwikkelcyclus (bun + watch)
  - Je loopt tegen Bun install/patch/lifecycle-scriptproblemen aan
title: "Bun (Experimenteel)"
---

# Bun (experimenteel)

Doel: deze repo draaien met **Bun** (optioneel, niet aanbevolen voor WhatsApp/Telegram)
zonder af te wijken van pnpm-workflows.

⚠️ **Niet aanbevolen voor Gateway-runtime** (WhatsApp/Telegram-bugs). Gebruik Node voor productie.

## Status

- Bun is een optionele lokale runtime om TypeScript direct uit te voeren (`bun run …`, `bun --watch …`).
- `pnpm` is de standaard voor builds en blijft volledig ondersteund (en wordt gebruikt door sommige documentatietools).
- Bun kan `pnpm-lock.yaml` niet gebruiken en zal dit negeren.

## Installeren

Standaard:

```sh
bun install
```

Let op: `bun.lock`/`bun.lockb` zijn door git genegeerd, dus er is hoe dan ook geen repo-churn. Als je _geen lockfile-wegschrijvingen_ wilt:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle-scripts (standaard geblokkeerd)

Bun kan lifecycle-scripts van afhankelijkheden blokkeren tenzij ze expliciet worden vertrouwd (`bun pm untrusted` / `bun pm trust`).
Voor deze repo zijn de vaak geblokkeerde scripts niet vereist:

- `@whiskeysockets/baileys` `preinstall`: controleert Node major >= 20 (wij draaien Node 22+).
- `protobufjs` `postinstall`: geeft waarschuwingen over incompatibele versieschema’s (geen build-artefacten).

Als je een echt runtime-probleem tegenkomt waarvoor deze scripts nodig zijn, vertrouw ze dan expliciet:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Opmerkingen

- Sommige scripts zijn nog steeds hardcoded op pnpm (bijv. `docs:build`, `ui:*`, `protocol:check`). Voer die voorlopig via pnpm uit.
