---
title: Pipeline CI
description: Comment fonctionne le pipeline CI d'OpenClaw
---

# Pipeline CI

La CI s'exécute à chaque push vers `main` et chaque pull request. Elle utilise une portée intelligente pour ignorer les tâches coûteuses quand seuls les docs ou le code natif ont changé.

## Aperçu des Tâches

| Tâche             | But                                                    | Quand elle s'exécute          |
| ----------------- | ------------------------------------------------------ | ----------------------------- |
| `docs-scope`      | Détecter changements docs-seulement                    | Toujours                      |
| `changed-scope`   | Détecter quelles zones ont changé (node/macos/android) | PRs non-docs                  |
| `check`           | Types TypeScript, lint, format                         | Changements non-docs          |
| `check-docs`      | Lint Markdown + vérification lien cassé                | Docs changés                  |
| `code-analysis`   | Vérification seuil LOC (1000 lignes)                   | PRs uniquement                |
| `secrets`         | Détecter fuites de secrets                             | Toujours                      |
| `build-artifacts` | Build dist une fois, partager avec autres tâches       | Non-docs, changements node    |
| `release-check`   | Valider contenu npm pack                               | Après build                   |
| `checks`          | Tests Node/Bun + vérification protocole                | Non-docs, changements node    |
| `checks-windows`  | Tests spécifiques Windows                              | Non-docs, changements node    |
| `macos`           | Lint/build/test Swift + tests TS                       | PRs avec changements macos    |
| `android`         | Build Gradle + tests                                   | Non-docs, changements android |

## Ordre Fail-Fast

Les tâches sont ordonnées pour que les vérifications peu coûteuses échouent avant que les coûteuses ne s'exécutent :

1. `docs-scope` + `code-analysis` + `check` (parallèle, ~1-2 min)
2. `build-artifacts` (bloqué sur ce qui précède)
3. `checks`, `checks-windows`, `macos`, `android` (bloqué sur build)

## Exécuteurs

| Exécuteur                       | Tâches                      |
| ------------------------------- | --------------------------- |
| `blacksmith-4vcpu-ubuntu-2404`  | La plupart des tâches Linux |
| `blacksmith-4vcpu-windows-2025` | `checks-windows`            |
| `macos-latest`                  | `macos`, `ios`              |
| `ubuntu-latest`                 | Détection portée (léger)    |

## Équivalents Locaux

```bash
pnpm check          # types + lint + format
pnpm test           # tests vitest
pnpm check:docs     # format docs + lint + liens cassés
pnpm release:check  # valider npm pack
```
