---
summary: Node + tsx-crashnotities en workarounds voor "__name is not a function"
read_when:
  - Debuggen van alleen-Node dev-scripts of watch-modusfouten
  - Onderzoeken van tsx/esbuild loader-crashes in OpenClaw
title: "Node + tsx-crash"
---

# Node + tsx "\_\_name is not a function"-crash

## Samenvatting

Het uitvoeren van OpenClaw via Node met `tsx` mislukt bij het opstarten met:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Dit begon na het overschakelen van dev-scripts van Bun naar `tsx` (commit `2871657e`, 2026-01-06). Hetzelfde runtimepad werkte met Bun.

## Omgeving

- Node: v25.x (waargenomen op v25.3.0)
- tsx: 4.21.0
- OS: macOS (repro waarschijnlijk ook op andere platforms die Node 25 draaien)

## Repro (alleen Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimale repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node-versiecontrole

- Node 25.3.0: faalt
- Node 22.22.0 (Homebrew `node@22`): faalt
- Node 24: hier nog niet geïnstalleerd; verificatie nodig

## Notities / hypothese

- `tsx` gebruikt esbuild om TS/ESM te transformeren. De `keepNames` van esbuild genereert een `__name`-helper en omwikkelt functiedefinities met `__name(...)`.
- De crash geeft aan dat `__name` bestaat maar geen functie is tijdens runtime, wat impliceert dat de helper ontbreekt of is overschreven voor deze module in het Node 25-loaderpad.
- Vergelijkbare problemen met de `__name`-helper zijn gemeld in andere esbuild-consumenten wanneer de helper ontbreekt of wordt herschreven.

## Regressiegeschiedenis

- `2871657e` (2026-01-06): scripts gewijzigd van Bun naar tsx om Bun optioneel te maken.
- Daarvoor (Bun-pad) werkten `openclaw status` en `gateway:watch`.

## Workarounds

- Gebruik Bun voor dev-scripts (huidige tijdelijke terugdraai).

- Gebruik Node + tsc watch en voer daarna de gecompileerde uitvoer uit:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Lokaal bevestigd: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` werkt op Node 25.

- Schakel esbuild keepNames uit in de TS-loader indien mogelijk (voorkomt invoeging van de `__name`-helper); tsx stelt dit momenteel niet bloot.

- Test Node LTS (22/24) met `tsx` om te zien of het probleem Node 25-specifiek is.

## Referenties

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Volgende stappen

- Repro op Node 22/24 om een Node 25-regressie te bevestigen.
- Test `tsx` nightly of pin naar een eerdere versie als er een bekende regressie bestaat.
- Als het ook op Node LTS reproduceert, dien een minimale repro upstream in met de `__name`-stacktrace.
