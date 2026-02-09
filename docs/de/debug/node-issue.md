---
summary: Node + tsx-Notizen und Workarounds zum Absturz „__name is not a function“
read_when:
  - Debugging von reinen Node-Dev-Skripten oder Fehlern im Watch-Modus
  - Untersuchung von tsx/esbuild-Loader-Abstürzen in OpenClaw
title: "Node + tsx-Absturz"
---

# Node + tsx-Absturz „\_\_name is not a function“

## Zusammenfassung

Das Ausführen von OpenClaw über Node mit `tsx` schlägt beim Start fehl mit:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Dies begann nach dem Wechsel der Dev-Skripte von Bun zu `tsx` (Commit `2871657e`, 2026-01-06). Derselbe Runtime-Pfad funktionierte mit Bun.

## Umgebung

- Node: v25.x (beobachtet mit v25.3.0)
- tsx: 4.21.0
- OS: macOS (Reproduktion wahrscheinlich auch auf anderen Plattformen, die Node 25 ausführen)

## Repro (nur Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimale Repro in Repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node-Versionsprüfung

- Node 25.3.0: schlägt fehl
- Node 22.22.0 (Homebrew `node@22`): schlägt fehl
- Node 24: hier noch nicht installiert; Verifizierung erforderlich

## Hinweise / Hypothese

- `tsx` verwendet esbuild zur Transformation von TS/ESM. esbuilds `keepNames` emittiert einen `__name`-Helper und umschließt Funktionsdefinitionen mit `__name(...)`.
- Der Absturz zeigt an, dass `__name` existiert, zur Laufzeit jedoch keine Funktion ist, was impliziert, dass der Helper für dieses Modul im Node-25-Loader-Pfad fehlt oder überschrieben wird.
- Ähnliche `__name`-Helper-Probleme wurden bei anderen esbuild-Nutzern berichtet, wenn der Helper fehlt oder umgeschrieben wird.

## Regressionshistorie

- `2871657e` (2026-01-06): Skripte von Bun auf tsx umgestellt, um Bun optional zu machen.
- Davor (Bun-Pfad) funktionierten `openclaw status` und `gateway:watch`.

## Workarounds

- Bun für Dev-Skripte verwenden (aktueller temporärer Revert).

- Node + tsc im Watch-Modus verwenden und dann das kompilierte Output ausführen:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Lokal bestätigt: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` funktioniert mit Node 25.

- esbuild keepNames im TS-Loader deaktivieren, falls möglich (verhindert die Einfügung des `__name`-Helpers); tsx stellt dies derzeit nicht bereit.

- Node LTS (22/24) mit `tsx` testen, um zu prüfen, ob das Problem Node-25-spezifisch ist.

## Referenzen

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Nächste Schritte

- Reproduktion unter Node 22/24, um eine Regression in Node 25 zu bestätigen.
- `tsx` nightly testen oder auf eine frühere Version pinnen, falls eine bekannte Regression existiert.
- Wenn es sich auch unter Node LTS reproduzieren lässt, ein minimales Repro upstream mit dem `__name`-Stacktrace einreichen.
