---
summary: Notes de crash Node + tsx "__name is not a function" et solutions de contournement
read_when:
  - Débogage de scripts de dev Node uniquement ou échecs du mode watch
  - Investigation de crashes du chargeur tsx/esbuild dans OpenClaw
title: "Crash Node + tsx"
---

# Crash Node + tsx "\_\_name is not a function"

## Résumé

L'exécution d'OpenClaw via Node avec `tsx` échoue au démarrage avec :

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Cela a commencé après le passage des scripts de dev de Bun à `tsx` (commit `2871657e`, 2026-01-06). Le même chemin d'exécution fonctionnait avec Bun.

## Environnement

- Node : v25.x (observé sur v25.3.0)
- tsx : 4.21.0
- OS : macOS (reproduction probable aussi sur d'autres plateformes exécutant Node 25)

## Reproduction (Node uniquement)

```bash
# dans la racine du dépôt
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Reproduction minimale dans le dépôt

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Vérification de version Node

- Node 25.3.0 : échoue
- Node 22.22.0 (Homebrew `node@22`) : échoue
- Node 24 : pas encore installé ici ; nécessite vérification

## Notes / hypothèse

- `tsx` utilise esbuild pour transformer TS/ESM. Le `keepNames` d'esbuild émet un helper `__name` et enveloppe les définitions de fonctions avec `__name(...)`.
- Le crash indique que `__name` existe mais n'est pas une fonction à l'exécution, ce qui implique que le helper est manquant ou écrasé pour ce module dans le chemin de chargeur Node 25.
- Des problèmes similaires de helper `__name` ont été signalés dans d'autres consommateurs esbuild quand le helper est manquant ou réécrit.

## Historique de régression

- `2871657e` (2026-01-06) : scripts changés de Bun à tsx pour rendre Bun optionnel.
- Avant cela (chemin Bun), `openclaw status` et `gateway:watch` fonctionnaient.

## Solutions de contournement

- Utiliser Bun pour les scripts de dev (retour temporaire actuel).
- Utiliser Node + tsc watch, puis exécuter la sortie compilée :

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Confirmé localement : `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` fonctionne sur Node 25.
- Désactiver esbuild keepNames dans le chargeur TS si possible (empêche l'insertion du helper `__name`) ; tsx n'expose pas actuellement cela.
- Tester Node LTS (22/24) avec `tsx` pour voir si le problème est spécifique à Node 25.

## Références

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Prochaines étapes

- Reproduire sur Node 22/24 pour confirmer la régression Node 25.
- Tester `tsx` nightly ou épingler à une version antérieure si une régression connue existe.
- Si reproduit sur Node LTS, déposer une reproduction minimale upstream avec la trace de pile `__name`.
