---
summary: "Bun-workflow (eksperimentel): installation og faldgruber vs pnpm"
read_when:
  - Du vil have den hurtigste lokale udviklingsloop (bun + watch)
  - Du støder på problemer med Bun install/patch/lifecycle-scripts
title: "Bun (Eksperimentel)"
---

# Bun (eksperimentel)

Mål: kør dette repo med **Bun** (valgfrit, ikke anbefalet til WhatsApp/Telegram)
uden at afvige fra pnpm-workflows.

⚠️ **Ikke anbefalet for Gateway runtime** (WhatsApp/Telegram bugs). Brug Node til produktion.

## Status

- Bun er et valgfrit lokalt runtime til at køre TypeScript direkte (`bun run …`, `bun --watch …`).
- `pnpm` er standard for builds og forbliver fuldt understøttet (og bruges af noget docs-værktøj).
- Bun kan ikke bruge `pnpm-lock.yaml` og vil ignorere det.

## Installér

Standard:

```sh
bun install
```

Bemærk: `bun.lock`/`bun.lockb` er gitignored, så der er ingen repo churn begge veje. Hvis du ønsker _no lockfile writes_:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Bun lifecycle-scripts (blokeret som standard)

Bun kan blokere afhængighed livscyklus scripts medmindre udtrykkeligt betroede (`bun pm untrusted` / `bun pm trust`).
For denne repo, er de almindeligt blokerede scripts ikke påkrævet:

- `@whiskeysockets/baileys` `preinstall`: tjekker Node major >= 20 (vi kører Node 22+).
- `protobufjs` `postinstall`: udsender advarsler om inkompatible versionsskemaer (ingen build-artifakter).

Hvis du rammer et reelt runtime-problem, der kræver disse scripts, så betro dem eksplicit:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Forbehold

- Nogle scripts stadig hardcode pnpm (f.eks. `docs:build`, `ui:*`, `protocol:check`). Kør dem via pnpm for nu.
