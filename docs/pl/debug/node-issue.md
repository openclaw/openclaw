---
summary: Notatki o awarii Node + tsx „__name is not a function” oraz obejścia
read_when:
  - Debugowanie skryptów deweloperskich tylko dla Node lub awarii trybu watch
  - Badanie awarii loadera tsx/esbuild w OpenClaw
title: "Awaria Node + tsx"
---

# Awaria Node + tsx „\_\_name is not a function”

## Podsumowanie

Uruchamianie OpenClaw przez Node z `tsx` kończy się niepowodzeniem przy starcie z komunikatem:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Problem pojawił się po przełączeniu skryptów deweloperskich z Bun na `tsx` (commit `2871657e`, 2026-01-06). Ta sama ścieżka uruchomieniowa działała z Bun.

## Środowisko

- Node: v25.x (zaobserwowane na v25.3.0)
- tsx: 4.21.0
- OS: macOS (reprodukcja prawdopodobna także na innych platformach uruchamiających Node 25)

## Repro (tylko Node)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimalna reprodukcja w repozytorium

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Sprawdzenie wersji Node

- Node 25.3.0: nie działa
- Node 22.22.0 (Homebrew `node@22`): nie działa
- Node 24: jeszcze nie zainstalowany; wymaga weryfikacji

## Uwagi / hipoteza

- `tsx` używa esbuild do transformacji TS/ESM. Opcja `keepNames` w esbuild emituje pomocnik `__name` i opakowuje definicje funkcji za pomocą `__name(...)`.
- Awaria wskazuje, że `__name` istnieje, ale w czasie wykonania nie jest funkcją, co sugeruje, że pomocnik jest brakujący lub nadpisany dla tego modułu w ścieżce loadera Node 25.
- Podobne problemy z pomocnikiem `__name` były zgłaszane w innych projektach korzystających z esbuild, gdy pomocnik jest brakujący lub przepisywany.

## Historia regresji

- `2871657e` (2026-01-06): skrypty zmienione z Bun na tsx, aby Bun był opcjonalny.
- Wcześniej (ścieżka Bun) działały `openclaw status` i `gateway:watch`.

## Prace

- Użycie Bun do skryptów deweloperskich (obecne tymczasowe cofnięcie).

- Użycie Node + watch tsc, a następnie uruchamianie skompilowanego wyjścia:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Potwierdzone lokalnie: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` działa na Node 25.

- Wyłączenie keepNames esbuild w loaderze TS, jeśli to możliwe (zapobiega wstawianiu pomocnika `__name`); tsx obecnie tego nie udostępnia.

- Przetestowanie Node LTS (22/24) z `tsx`, aby sprawdzić, czy problem jest specyficzny dla Node 25.

## Odniesienia

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Następne kroki

- Reprodukcja na Node 22/24 w celu potwierdzenia regresji w Node 25.
- Test `tsx` nightly lub przypięcie do wcześniejszej wersji, jeśli istnieje znana regresja.
- Jeśli odtwarza się na Node LTS, zgłoszenie minimalnej reprodukcji upstream z `__name` stack trace.
