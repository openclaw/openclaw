---
summary: "Reference CLI pour `openclaw update` (mise a jour de la source plutot sure + redemarrage automatique de la Gateway (passerelle))"
read_when:
  - Vous voulez mettre a jour un checkout source en toute securite
  - Vous devez comprendre le comportement du raccourci `--update`
title: "update"
---

# `openclaw update`

Met a jour OpenClaw en toute securite et permet de basculer entre les canaux stable/beta/dev.

Si vous avez installe via **npm/pnpm** (installation globale, sans metadonnees git), les mises a jour se font via le flux du gestionnaire de paquets dans [Updating](/install/updating).

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

- `--no-restart` : ignorer le redemarrage du service Gateway (passerelle) apres une mise a jour reussie.
- `--channel <stable|beta|dev>` : definir le canal de mise a jour (git + npm ; persiste dans la configuration).
- `--tag <dist-tag|version>` : forcer le dist-tag npm ou la version uniquement pour cette mise a jour.
- `--json` : afficher le JSON `UpdateRunResult` lisible par machine.
- `--timeout <seconds>` : delai d’expiration par etape (1200 s par defaut).

Remarque : les retours en arriere (downgrades) necessitent une confirmation, car les versions plus anciennes peuvent casser la configuration.

## `update status`

Affiche le canal de mise a jour actif + le tag/branche/SHA git (pour les checkouts source), ainsi que la disponibilite des mises a jour.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Options :

- `--json` : afficher le JSON d’etat lisible par machine.
- `--timeout <seconds>` : delai d’expiration pour les verifications (3 s par defaut).

## `update wizard`

Flux interactif pour choisir un canal de mise a jour et confirmer s’il faut redemarrer la Gateway
apres la mise a jour (le comportement par defaut est de redemarrer). Si vous selectionnez `dev` sans checkout git, l’outil propose d’en creer un.

## Ce que cela fait

Lorsque vous changez explicitement de canal (`--channel ...`), OpenClaw maintient egalement l’alignement de la methode d’installation :

- `dev` → garantit un checkout git (par defaut : `~/openclaw`, surcharge possible avec `OPENCLAW_GIT_DIR`),
  le met a jour et installe la CLI globale depuis ce checkout.
- `stable`/`beta` → installe depuis npm en utilisant le dist-tag correspondant.

## Flux de checkout git

Canaux :

- `stable` : checkout du dernier tag non beta, puis build + doctor.
- `beta` : checkout du dernier tag `-beta`, puis build + doctor.
- `dev` : checkout de `main`, puis fetch + rebase.

Niveau supérieur:

1. Necessite un worktree propre (aucune modification non committee).
2. Bascule vers le canal selectionne (tag ou branche).
3. Recupere l’amont (dev uniquement).
4. Dev uniquement : lint de precontrole + build TypeScript dans un worktree temporaire ; si la tete echoue, remonte jusqu’a 10 commits pour trouver le build propre le plus recent.
5. Rebase sur le commit selectionne (dev uniquement).
6. Installe les dependances (pnpm privilegie ; repli sur npm).
7. Build + build de l’interface Control UI.
8. Execute `openclaw doctor` comme verification finale de « mise a jour sure ».
9. Synchronise les plugins avec le canal actif (dev utilise les extensions fournies ; stable/beta utilise npm) et met a jour les plugins installes via npm.

## Raccourci `--update`

`openclaw --update` est recrit en `openclaw update` (utile pour les shells et les scripts de lancement).

## Voir aussi

- `openclaw doctor` (propose d’executer d’abord la mise a jour sur les checkouts git)
- [Development channels](/install/development-channels)
- [Updating](/install/updating)
- [Reference CLI](/cli)
