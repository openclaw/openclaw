---
summary: Noter og workarounds for Node + tsx "__name er ikke en funktion"-crash
read_when:
  - Fejlfinding af Node-only dev-scripts eller fejl i watch-tilstand
  - Undersøgelse af tsx/esbuild loader-crash i OpenClaw
title: "Node + tsx Crash"
---

# Node + tsx "\_\_name er ikke en funktion"-crash

## Resumé

Kørsel af OpenClaw via Node med `tsx` fejler ved opstart med:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Dette begyndte efter at skifte dev scripts fra Bun til `tsx` (begå `2871657e`, 2026-01-06). Samme runtime sti arbejdede med Bun.

## Miljø

- Node: v25.x (observeret på v25.3.0)
- tsx: 4.21.0
- OS: macOS (repro sandsynligvis også på andre platforme, der kører Node 25)

## Repro (kun Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro i repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node-versionskontrol

- Node 25.3.0: fejler
- Node 22.22.0 (Homebrew `node@22`): fejler
- Node 24: ikke installeret her endnu; kræver verifikation

## Noter / hypotese

- `tsx` bruger esbuild til at omdanne TS/ESM. esbuild's `keepNames` udsender en `__name` hjælper og wraps funktion definitioner med `__name(...)`.
- Crashet indikerer, at `__name` findes, men ikke er en funktion ved runtime, hvilket antyder, at helperen mangler eller er overskrevet for dette modul i Node 25 loader-stien.
- Lignende `__name`-helperproblemer er rapporteret i andre esbuild-forbrugere, når helperen mangler eller omskrives.

## Regressionshistorik

- `2871657e` (2026-01-06): scripts ændret fra Bun til tsx for at gøre Bun valgfri.
- Før det (Bun-stien) virkede `openclaw status` og `gateway:watch`.

## Workarounds

- Brug Bun til dev-scripts (nuværende midlertidige revert).

- Brug Node + tsc watch, og kør derefter kompileret output:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Bekræftet lokalt: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` virker på Node 25.

- Deaktivér esbuild keepNames i TS-loaderen hvis muligt (forhindrer indsættelse af `__name`-helperen); tsx eksponerer dette ikke i øjeblikket.

- Test Node LTS (22/24) med `tsx` for at se, om problemet er specifikt for Node 25.

## Referencer

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Næste trin

- Reproducer på Node 22/24 for at bekræfte regression i Node 25.
- Test `tsx` nightly eller fastlås til en tidligere version, hvis der findes en kendt regression.
- Hvis det reproduceres på Node LTS, indsend en minimal repro upstream med `__name` stack trace.
