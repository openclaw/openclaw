---
summary: Notes et solutions de contournement pour le crash Node + tsx « __name is not a function »
read_when:
  - Debogage de scripts de dev Node uniquement ou d’echecs en mode watch
  - Investigation des crashs du chargeur tsx/esbuild dans OpenClaw
title: "Crash Node + tsx"
---

# Node + tsx "\_\_name is not a function" crash

## Summary

L’execution d’OpenClaw via Node avec `tsx` echoue au demarrage avec :

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Cela a commence apres le passage des scripts de dev de Bun a `tsx` (commit `2871657e`, 2026-01-06). Le meme chemin d’execution fonctionnait avec Bun.

## Environment

- Node : v25.x (observe sur v25.3.0)
- tsx : 4.21.0
- OS : macOS (la reproduction est probablement possible aussi sur d’autres plateformes executant Node 25)

## Repro (Node-only)

```bash
# in repo root
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Minimal repro in repo

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Node version check

- Node 25.3.0 : echec
- Node 22.22.0 (Homebrew `node@22`) : echec
- Node 24 : pas encore installe ici ; verification necessaire

## Notes / hypothesis

- `tsx` utilise esbuild pour transformer TS/ESM. L’option `keepNames` d’esbuild emet un helper `__name` et enveloppe les definitions de fonctions avec `__name(...)`.
- Le crash indique que `__name` existe mais n’est pas une fonction a l’execution, ce qui implique que le helper est manquant ou ecrase pour ce module dans le chemin du chargeur Node 25.
- Des problemes similaires de helper `__name` ont ete signales dans d’autres consommateurs d’esbuild lorsque le helper est manquant ou reecrit.

## Regression history

- `2871657e` (2026-01-06) : les scripts sont passes de Bun a tsx afin de rendre Bun optionnel.
- Avant cela (chemin Bun), `openclaw status` et `gateway:watch` fonctionnaient.

## Workarounds

- Utiliser Bun pour les scripts de dev (retour temporaire actuel).

- Utiliser Node + tsc en mode watch, puis executer la sortie compilee :

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Confirme localement : `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` fonctionne avec Node 25.

- Desactiver keepNames d’esbuild dans le chargeur TS si possible (empeche l’insertion du helper `__name`) ; tsx ne l’expose pas actuellement.

- Tester Node LTS (22/24) avec `tsx` pour voir si le probleme est specifique a Node 25.

## References

- https://opennext.js.org/cloudflare/howtos/keep_names
- https://esbuild.github.io/api/#keep-names
- https://github.com/evanw/esbuild/issues/1031

## Next steps

- Reproduire sur Node 22/24 pour confirmer une regression de Node 25.
- Tester `tsx` nightly ou figer sur une version anterieure si une regression connue existe.
- Si la reproduction se fait sur Node LTS, deposer un repro minimal en amont avec la trace de pile `__name`.
