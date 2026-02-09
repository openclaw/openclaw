---
summary: Anteckningar och lösningar för Node + tsx-krasch med ”__name is not a function”
read_when:
  - Felsökning av Node-baserade utvecklingsskript eller fel i watch-läge
  - Undersökning av tsx/esbuild-loaderkrascher i OpenClaw
title: "Node + tsx-krasch"
---

# Node + tsx ”\_\_name is not a function”-krasch

## Sammanfattning

När OpenClaw körs via Node med `tsx` misslyckas uppstarten med:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Detta började efter att ha bytt dev skript från Bun till `tsx` (commit `2871657e`, 2026-01-06). Samma bana fungerade med Bun.

## Miljö

- Node: v25.x (observerat på v25.3.0)
- tsx: 4.21.0
- OS: macOS (repro är sannolikt även på andra plattformar som kör Node 25)

## Repro (endast Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro i repot

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Kontroll av Node-version

- Node 25.3.0: misslyckas
- Node 22.22.0 (Homebrew `node@22`): misslyckas
- Node 24: inte installerad här ännu; behöver verifieras

## Noteringar / hypotes

- `tsx` använder esbuild för att omvandla TS/ESM. esbuild’s `keepNames` avger en `__name`-hjälpare och wraps funktionsdefinitioner med `__name(...)`.
- Kraschen indikerar att `__name` finns men inte är en funktion vid körning, vilket innebär att hjälpfunktionen saknas eller har skrivits över för denna modul i Node 25:s loader-sökväg.
- Liknande problem med `__name`-hjälpfunktioner har rapporterats i andra esbuild-konsumenter när hjälpfunktionen saknas eller skrivs om.

## Regressionshistorik

- `2871657e` (2026-01-06): skripten ändrades från Bun till tsx för att göra Bun valfritt.
- Innan dess (Bun-vägen) fungerade `openclaw status` och `gateway:watch`.

## Lösningar

- Använd Bun för utvecklingsskript (nuvarande tillfälliga återställning).

- Använd Node + tsc watch och kör sedan kompilerad utdata:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Bekräftat lokalt: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` fungerar på Node 25.

- Inaktivera esbuild keepNames i TS-loadern om möjligt (förhindrar insättning av `__name`-hjälpfunktionen); tsx exponerar inte detta i nuläget.

- Testa Node LTS (22/24) med `tsx` för att se om problemet är specifikt för Node 25.

## Referenser

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Nästa steg

- Repro på Node 22/24 för att bekräfta regression i Node 25.
- Testa `tsx` nightly eller lås till en tidigare version om en känd regression finns.
- Om det reproduceras på Node LTS, skapa ett minimalt repro uppströms med `__name`-stackspåret.
