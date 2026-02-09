---
summary: Mga tala at workaround sa pag-crash ng Node + tsx na "__name is not a function"
read_when:
  - Pag-debug ng mga Node-only dev script o mga pagkabigo sa watch mode
  - Pag-iimbestiga ng mga pag-crash ng tsx/esbuild loader sa OpenClaw
title: "Node + tsx Pag-crash"
---

# Node + tsx "\_\_name is not a function" pag-crash

## Buod

Ang pagpapatakbo ng OpenClaw sa pamamagitan ng Node na may `tsx` ay nabibigo sa startup na may:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

This began after switching dev scripts from Bun to `tsx` (commit `2871657e`, 2026-01-06). Ginagamit ng `tsx` ang esbuild para i-transform ang TS/ESM.

## Kapaligiran

- Node: v25.x (naobserbahan sa v25.3.0)
- tsx: 4.21.0
- OS: macOS (malamang na marepro rin sa iba pang platform na tumatakbo sa Node 25)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro sa repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Pagsusuri ng bersyon ng Node

- Node 25.3.0: pumapalya
- Node 22.22.0 (Homebrew `node@22`): pumapalya
- Node 24: hindi pa naka-install dito; kailangan ng beripikasyon

## Mga tala / haka-haka

- Ang `keepNames` ng esbuild ay naglalabas ng `__name` helper at binabalutan ang mga function definition ng `__name(...)`. esbuild’s `keepNames` emits a `__name` helper and wraps function definitions with `__name(...)`.
- Ipinapahiwatig ng pag-crash na umiiral ang `__name` ngunit hindi ito isang function sa runtime, na nagpapahiwatig na nawawala o na-overwrite ang helper para sa module na ito sa Node 25 loader path.
- May mga kahalintulad na isyu sa `__name` helper na naiulat sa iba pang esbuild consumer kapag nawawala o nire-rewrite ang helper.

## Kasaysayan ng regression

- `2871657e` (2026-01-06): pinalitan ang mga script mula Bun patungong tsx upang gawing opsyonal ang Bun.
- Bago iyon (Bun path), gumagana ang `openclaw status` at `gateway:watch`.

## Mga workaround

- Gumamit ng Bun para sa mga dev script (kasalukuyang pansamantalang revert).

- Gumamit ng Node + tsc watch, pagkatapos ay patakbuhin ang compiled output:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Nakumpirma nang lokal: gumagana ang `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` sa Node 25.

- I-disable ang esbuild keepNames sa TS loader kung posible (pinipigilan ang pagpasok ng `__name` helper); kasalukuyang hindi ito ine-expose ng tsx.

- Subukan ang Node LTS (22/24) gamit ang `tsx` upang makita kung Node 25–specific ang isyu.

## Mga sanggunian

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Mga susunod na hakbang

- Mag-repro sa Node 22/24 upang makumpirma ang Node 25 regression.
- Subukan ang `tsx` nightly o i-pin sa mas naunang bersyon kung may kilalang regression.
- Kung mare-repro sa Node LTS, magsumite ng minimal repro upstream kasama ang `__name` stack trace.
