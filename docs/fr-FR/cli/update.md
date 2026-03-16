---
summary: "Référence CLI pour `openclaw update` (mise à jour source sûre + redémarrage auto de passerelle)"
read_when:
  - Vous voulez mettre à jour un checkout source en toute sécurité
  - Vous devez comprendre le comportement raccourci `--update`
title: "update"
---

# `openclaw update`

Mettre à jour OpenClaw en toute sécurité et basculer entre les canaux stable/beta/dev.

Si vous avez installé via **npm/pnpm** (installation globale, pas de métadonnées git), les mises à jour se font via le flux de gestionnaire de paquets dans [Mise à jour](/fr-FR/install/updating).

## Utilisation

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Options

- `--no-restart` : ignorer le redémarrage du service Passerelle après une mise à jour réussie.
- `--channel <stable|beta|dev>` : définir le canal de mise à jour (git + npm ; persisté dans config).
- `--tag <dist-tag|version>` : remplacer le dist-tag ou version npm pour cette mise à jour uniquement.
- `--json` : afficher JSON `UpdateRunResult` lisible par machine.
- `--timeout <seconds>` : timeout par étape (par défaut 1200s).

Note : les downgrades nécessitent une confirmation car les versions plus anciennes peuvent casser la configuration.

## `update status`

Afficher le canal de mise à jour actif + tag/branche/SHA git (pour checkouts source), plus la disponibilité de mise à jour.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options :

- `--json` : afficher JSON de statut lisible par machine.
- `--timeout <seconds>` : timeout pour les vérifications (par défaut 3s).

## `update wizard`

Flux interactif pour choisir un canal de mise à jour et confirmer s'il faut redémarrer la Passerelle après mise à jour (par défaut est de redémarrer). Si vous sélectionnez `dev` sans checkout git, il propose d'en créer un.

## Ce qu'il fait

Quand vous basculez explicitement les canaux (`--channel ...`), OpenClaw garde aussi la méthode d'installation alignée :

- `dev` → assure un checkout git (par défaut : `~/openclaw`, remplacer avec `OPENCLAW_GIT_DIR`), le met à jour, et installe la CLI globale depuis ce checkout.
- `stable`/`beta` → installe depuis npm en utilisant le dist-tag correspondant.

## Flux de checkout Git

Canaux :

- `stable` : checkout du dernier tag non-beta, puis build + doctor.
- `beta` : checkout du dernier tag `-beta`, puis build + doctor.
- `dev` : checkout `main`, puis fetch + rebase.

Haut niveau :

1. Nécessite un worktree propre (pas de changements non commités).
2. Bascule vers le canal sélectionné (tag ou branche).
3. Récupère upstream (dev uniquement).
4. Dev uniquement : preflight lint + build TypeScript dans un worktree temp ; si le tip échoue, remonte jusqu'à 10 commits pour trouver le build propre le plus récent.
5. Rebase sur le commit sélectionné (dev uniquement).
6. Installe les deps (pnpm préféré ; fallback npm).
7. Build + build l'UI de Contrôle.
8. Exécute `openclaw doctor` comme vérification finale de "mise à jour sûre".
9. Synchronise les plugins au canal actif (dev utilise les extensions intégrées ; stable/beta utilise npm) et met à jour les plugins installés via npm.

## Raccourci `--update`

`openclaw --update` se réécrit en `openclaw update` (utile pour les shells et scripts de lancement).

## Voir aussi

- `openclaw doctor` (propose d'exécuter update d'abord sur les checkouts git)
- [Canaux de développement](/fr-FR/install/development-channels)
- [Mise à jour](/fr-FR/install/updating)
- [Référence CLI](/fr-FR/cli)
