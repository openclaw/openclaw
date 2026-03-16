---
summary: "Manifeste de plugin + exigences de schéma JSON (validation de config stricte)"
read_when:
  - Vous construisez un plugin OpenClaw
  - Vous devez livrer un schéma de config de plugin ou déboguer des erreurs de validation de plugin
title: "Manifeste de plugin"
---

# Manifeste de plugin (openclaw.plugin.json)

Chaque plugin **doit** livrer un fichier `openclaw.plugin.json` dans la **racine du plugin**.
OpenClaw utilise ce manifeste pour valider la configuration **sans exécuter le code du
plugin**. Les manifestes manquants ou invalides sont traités comme des erreurs de plugin et bloquent
la validation de config.

Voir le guide complet du système de plugins : [Plugins](/fr-FR/tools/plugin).

## Champs requis

```json
{
  "id": "voice-call",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

Clés requises :

- `id` (chaîne) : id de plugin canonique.
- `configSchema` (objet) : Schéma JSON pour la config du plugin (inline).

Clés optionnelles :

- `kind` (chaîne) : type de plugin (exemple : `"memory"`).
- `channels` (tableau) : ids de canal enregistrés par ce plugin (exemple : `["matrix"]`).
- `providers` (tableau) : ids de fournisseur enregistrés par ce plugin.
- `skills` (tableau) : répertoires de compétences à charger (relatif à la racine du plugin).
- `name` (chaîne) : nom d'affichage pour le plugin.
- `description` (chaîne) : résumé court du plugin.
- `uiHints` (objet) : labels/placeholders/flags sensibles de champ de config pour le rendu UI.
- `version` (chaîne) : version du plugin (informatif).

## Exigences de schéma JSON

- **Chaque plugin doit livrer un schéma JSON**, même s'il n'accepte aucune config.
- Un schéma vide est acceptable (par exemple, `{ "type": "object", "additionalProperties": false }`).
- Les schémas sont validés au moment de la lecture/écriture de config, pas à l'exécution.

## Comportement de validation

- Les clés `channels.*` inconnues sont des **erreurs**, sauf si l'id de canal est déclaré par
  un manifeste de plugin.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny`, et `plugins.slots.*`
  doivent référencer des ids de plugin **découvrables**. Les ids inconnus sont des **erreurs**.
- Si un plugin est installé mais a un manifeste ou schéma cassé ou manquant,
  la validation échoue et Doctor signale l'erreur du plugin.
- Si la config du plugin existe mais que le plugin est **désactivé**, la config est conservée et
  un **avertissement** est affiché dans Doctor + logs.

## Notes

- Le manifeste est **requis pour tous les plugins**, y compris les chargements du système de fichiers local.
- L'exécution charge toujours le module de plugin séparément ; le manifeste est uniquement pour
  la découverte + validation.
- Si votre plugin dépend de modules natifs, documentez les étapes de build et toute
  exigence de liste blanche de gestionnaire de packages (par exemple, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
