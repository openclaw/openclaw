---
summary: "Validation config stricte + migrations doctor-only"
read_when:
  - Design ou implémentation comportement validation config
  - Travail migrations config ou workflows doctor
  - Gestion schémas config plugin ou gating load plugin
title: "Validation Config Stricte"
---

# Validation config stricte (migrations doctor-only)

## Objectifs

- **Rejeter clés config inconnues partout** (racine + nested), sauf métadata racine `$schema`.
- **Rejeter config plugin sans schéma** ; ne chargez pas ce plugin.
- **Supprimer auto-migration legacy au chargement** ; migrations exécutées via doctor seulement.
- **Auto-exécuter doctor (dry-run) au démarrage** ; si invalide, bloquer commandes non-diagnostiques.

## Non-objectifs

- Compatibilité backward au chargement (clés legacy ne migrent pas auto).
- Drops silencieux clés non reconnues.

## Règles validation stricte

- Config doit matcher schéma exactement à chaque niveau.
- Clés inconnues sont erreurs validation (aucun passthrough racine ou nested), sauf racine `$schema` quand string.
- `plugins.entries.<id>.config` doit être validé par schéma plugin.
  - Si plugin manque schéma, **rejeter load plugin** et surfacer erreur claire.
- Clés `channels.<id>` inconnues sont erreurs sauf si manifest plugin déclare id channel.
- Manifests plugin (`openclaw.plugin.json`) requis pour tous plugins.

## Enforcement schéma plugin

- Chaque plugin fournit schéma JSON Schema strict pour sa config (inline dans manifest).
- Flux load plugin :
  1. Résoudre manifest plugin + schéma (`openclaw.plugin.json`).
  2. Valider config contre schéma.
  3. Si schéma manquant ou config invalide : bloquer load plugin, enregistrer erreur.
- Message erreur inclut :
  - ID plugin
  - Raison (schéma manquant / config invalide)
  - Chemin(s) ayant échoué validation
- Plugins désactivés gardent leur config, mais Doctor + logs surfacent warning.

## Flux Doctor

- Doctor tourne **à chaque fois** config chargée (dry-run par défaut).
- Si config invalide :
  - Afficher résumé + erreurs actionnables.
  - Instruire : `openclaw doctor --fix`.
- `openclaw doctor --fix` :
  - Applique migrations.
  - Supprime clés inconnues.
  - Écrit config mise à jour.

## Gating commande (quand config invalide)

Autorisé (diagnostic-only) :

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Tout le reste doit hard-fail avec : "Config invalid. Run `openclaw doctor --fix`."

## Format UX erreur

- Header résumé unique.
- Sections groupées :
  - Clés inconnues (chemins complets)
  - Clés legacy / migrations nécessaires
  - Échecs load plugin (id plugin + raison + chemin)

## Points contact implémentation

- `src/config/zod-schema.ts` : supprimer passthrough racine ; objets stricts partout.
- `src/config/loader.ts` : dry-run doctor au chargement.
- `src/plugins/loader.ts` : enforcement schéma plugin.
- `src/cli/commands/doctor.ts` : flux migration + fix.

Voir aussi :

- [Doctor](/fr-FR/cli/doctor)
- [Configuration](/fr-FR/gateway/configuration)
- [Plugins](/fr-FR/tools/plugin)
