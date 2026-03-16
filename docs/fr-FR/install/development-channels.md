---
summary: "Canaux stable, beta et dev : sémantique, basculement et étiquetage"
read_when:
  - Vous voulez basculer entre stable/beta/dev
  - Vous étiquetez ou publiez des préversions
title: "Canaux de développement"
---

# Canaux de développement

Dernière mise à jour : 2026-01-21

OpenClaw propose trois canaux de mise à jour :

- **stable** : npm dist-tag `latest`.
- **beta** : npm dist-tag `beta` (versions en test).
- **dev** : tête mobile de `main` (git). npm dist-tag : `dev` (quand publié).

Nous publions des versions vers **beta**, les testons, puis **promouvons une version vérifiée vers `latest`**
sans changer le numéro de version — les dist-tags sont la source de vérité pour les installations npm.

## Basculer entre canaux

Dépôt Git :

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

- `stable`/`beta` bascule vers la dernière étiquette correspondante (souvent la même étiquette).
- `dev` bascule vers `main` et rebase sur l'upstream.

Installation globale npm/pnpm :

```bash
openclaw update --channel stable
openclaw update --channel beta
openclaw update --channel dev
```

Cela met à jour via le dist-tag npm correspondant (`latest`, `beta`, `dev`).

Quand vous basculez **explicitement** de canal avec `--channel`, OpenClaw aligne aussi
la méthode d'installation :

- `dev` garantit un dépôt git (par défaut `~/openclaw`, outrepasser avec `OPENCLAW_GIT_DIR`),
  le met à jour, et installe le CLI global depuis ce dépôt.
- `stable`/`beta` installe depuis npm en utilisant le dist-tag correspondant.

Astuce : si vous voulez stable + dev en parallèle, gardez deux clones et pointez votre passerelle vers celui stable.

## Plugins et canaux

Quand vous basculez de canal avec `openclaw update`, OpenClaw synchronise aussi les sources de plugin :

- `dev` préfère les plugins groupés depuis le dépôt git.
- `stable` et `beta` restaurent les packages de plugin installés via npm.

## Bonnes pratiques d'étiquetage

- Étiquetez les versions sur lesquelles vous voulez que les dépôts git atterrissent (`vYYYY.M.D` ou `vYYYY.M.D-<patch>`).
- Gardez les étiquettes immuables : ne déplacez ou ne réutilisez jamais une étiquette.
- Les dist-tags npm restent la source de vérité pour les installations npm :
  - `latest` → stable
  - `beta` → version candidate
  - `dev` → snapshot main (optionnel)

## Disponibilité de l'app macOS

Les versions beta et dev peuvent **ne pas** inclure une version de l'app macOS. C'est acceptable :

- L'étiquette git et le dist-tag npm peuvent quand même être publiés.
- Mentionnez "pas de version macOS pour cette beta" dans les notes de version ou le changelog.
