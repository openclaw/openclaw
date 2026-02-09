---
summary: "Validation stricte de la configuration + migrations uniquement via doctor"
read_when:
  - Conception ou implémentation du comportement de validation de la configuration
  - Travail sur les migrations de configuration ou les workflows doctor
  - Gestion des schémas de configuration des plugins ou du blocage du chargement des plugins
title: "Validation stricte de la configuration"
---

# Validation stricte de la configuration (migrations uniquement via doctor)

## Objectifs

- **Rejeter les clés de configuration inconnues partout** (racine + niveaux imbriqués).
- **Rejeter la configuration de plugin sans schéma** ; ne pas charger ce plugin.
- **Supprimer l’auto‑migration héritée au chargement** ; les migrations s’exécutent uniquement via doctor.
- **Exécuter automatiquement doctor (dry‑run) au démarrage** ; si la configuration est invalide, bloquer les commandes non diagnostiques.

## Non‑objectifs

- Compatibilité ascendante au chargement (les clés héritées ne sont pas auto‑migrées).
- Suppression silencieuse des clés non reconnues.

## Règles de validation stricte

- La configuration doit correspondre exactement au schéma à tous les niveaux.
- Les clés inconnues sont des erreurs de validation (aucun passthrough à la racine ou dans les niveaux imbriqués).
- `plugins.entries.<id>.config` doit être validé par le schéma du plugin.
  - Si un plugin ne dispose pas de schéma, **rejeter le chargement du plugin** et afficher une erreur claire.
- Les clés `channels.<id>` inconnues sont des erreurs, sauf si un manifeste de plugin déclare l’identifiant de canal.
- Les manifestes de plugin (`openclaw.plugin.json`) sont obligatoires pour tous les plugins.

## Application des schémas de plugin

- Chaque plugin fournit un schéma JSON strict pour sa configuration (intégré dans le manifeste).
- Flux de chargement des plugins :
  1. Résoudre le manifeste du plugin + le schéma (`openclaw.plugin.json`).
  2. Valider la configuration par rapport au schéma.
  3. En cas de schéma manquant ou de configuration invalide : bloquer le chargement du plugin, enregistrer l’erreur.
- Le message d’erreur inclut :
  - L’identifiant du plugin
  - La raison (schéma manquant / configuration invalide)
  - Le ou les chemins ayant échoué à la validation
- Les plugins désactivés conservent leur configuration, mais Doctor + les logs affichent un avertissement.

## Flux Doctor

- Doctor s’exécute **à chaque chargement** de la configuration (dry‑run par défaut).
- Si la configuration est invalide :
  - Afficher un résumé + des erreurs actionnables.
  - Instruction : `openclaw doctor --fix`.
- `openclaw doctor --fix` :
  - Applique les migrations.
  - Supprime les clés inconnues.
  - Écrit la configuration mise à jour.

## Blocage des commandes (lorsque la configuration est invalide)

Autorisé (diagnostic uniquement) :

- `openclaw doctor`
- `openclaw logs`
- `openclaw health`
- `openclaw help`
- `openclaw status`
- `openclaw gateway status`

Tout le reste doit échouer immédiatement avec : « Configuration invalide. Exécutez `openclaw doctor --fix`.

## Format UX des erreurs

- Un seul en‑tête de résumé.
- Sections regroupées :
  - Clés inconnues (chemins complets)
  - Clés héritées / migrations requises
  - Échecs de chargement de plugin (identifiant du plugin + raison + chemin)

## Points de contact d’implémentation

- `src/config/zod-schema.ts` : supprimer le passthrough à la racine ; objets stricts partout.
- `src/config/zod-schema.providers.ts` : garantir des schémas de canal stricts.
- `src/config/validation.ts` : échouer en cas de clés inconnues ; ne pas appliquer les migrations héritées.
- `src/config/io.ts` : supprimer les auto‑migrations héritées ; toujours exécuter doctor en dry‑run.
- `src/config/legacy*.ts` : déplacer l’usage vers doctor uniquement.
- `src/plugins/*` : ajouter un registre de schémas + le blocage.
- Blocage des commandes CLI dans `src/cli`.

## Tests

- Rejet des clés inconnues (racine + niveaux imbriqués).
- Plugin sans schéma → chargement du plugin bloqué avec une erreur claire.
- Configuration invalide → démarrage de la Gateway (passerelle) bloqué, sauf pour les commandes de diagnostic.
- Doctor en dry‑run automatique ; `doctor --fix` écrit la configuration corrigée.
