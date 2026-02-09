---
summary: "Canaux stable, beta et dev : sémantique, bascule et balisage"
read_when:
  - Vous souhaitez basculer entre stable/beta/dev
  - Vous balisez ou publiez des préversions
title: "Canaux de développement"
---

# Canaux de développement

Dernière mise à jour : 2026-01-21

OpenClaw propose trois canaux de mise à jour :

- **stable** : npm dist-tag `latest`.
- **beta** : npm dist-tag `beta` (builds en cours de test).
- **dev** : tête mobile de `main` (git). npm dist-tag : `dev` (lorsqu’il est publié).

Nous livrons des builds en **beta**, les testons, puis **promouvons un build validé vers `latest`**
sans changer le numéro de version — les dist-tags constituent la source de vérité pour les installations npm.

## Changer de canal

Commander Git :

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` extrait le dernier tag correspondant (souvent le même tag).
- `dev` bascule vers `main` et rebase sur l’amont.

Installation globale npm/pnpm :

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Cela met à jour via le dist-tag npm correspondant (`latest`, `beta`, `dev`).

Lorsque vous changez **explicitement** de canal avec `--channel`, OpenClaw aligne aussi
la méthode d’installation :

- `dev` garantit une extraction git (par défaut `~/openclaw`, remplacement avec `OPENCLAW_GIT_DIR`),
  la met à jour et installe la CLI globale depuis cette extraction.
- `stable`/`beta` installe depuis npm en utilisant le dist-tag correspondant.

Astuce : si vous souhaitez stable + dev en parallèle, conservez deux clones et pointez votre Gateway (passerelle) vers le stable.

## Plugins et canaux

Lorsque vous changez de canal avec `openclaw update`, OpenClaw synchronise aussi les sources de plugins :

- `dev` privilégie les plugins fournis avec l’extraction git.
- `stable` et `beta` rétablissent les paquets de plugins installés via npm.

## Étiquetage des meilleures pratiques

- Les marques que vous voulez que git checkouts atterrissent sur (`vYYYY.M.D` ou `vYYYY.M.D-<patch>`).
- Conservez des tags immuables : ne déplacez ni ne réutilisez jamais un tag.
- Les dist-tags npm restent la source de vérité pour les installations npm :
  - `latest` → stable
  - `beta` → build candidat
  - `dev` → instantané de la branche principale (optionnel)

## Disponibilité de l’app macOS

Les builds beta et dev peuvent **ne pas** inclure de version de l’app macOS. C’est normal :

- Le tag git et le dist-tag npm peuvent tout de même être publiés.
- Indiquez « pas de build macOS pour cette beta » dans les notes de version ou le changelog.
