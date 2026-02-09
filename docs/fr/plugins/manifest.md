---
summary: "Manifeste de plugin + exigences de schéma JSON (validation stricte de la configuration)"
read_when:
  - Vous construisez un plugin OpenClaw
  - Vous devez livrer un schéma de configuration de plugin ou déboguer des erreurs de validation de plugin
title: "Manifeste de plugin"
---

# Manifeste de plugin (openclaw.plugin.json)

Chaque plugin **doit** fournir un fichier `openclaw.plugin.json` dans la **racine du plugin**.
OpenClaw utilise ce manifeste pour valider la configuration **sans exécuter le code du plugin**. Les manifestes manquants ou invalides sont traités comme des erreurs de plugin et bloquent
la validation de la configuration.

Voir le guide complet du système de plugins : [Plugins](/plugin).

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

- `id` (string) : identifiant canonique du plugin.
- `configSchema` (object) : schéma JSON pour la configuration du plugin (inline).

Clés optionnelles :

- `kind` (string) : type de plugin (exemple : `"memory"`).
- `channels` (array) : identifiants de canaux enregistrés par ce plugin (exemple : `["matrix"]`).
- `providers` (array) : identifiants de fournisseurs enregistrés par ce plugin.
- `skills` (array) : répertoires de Skills à charger (relatifs à la racine du plugin).
- `name` (string) : nom d’affichage du plugin.
- `description` (string) : résumé court du plugin.
- `uiHints` (object) : libellés/espaces réservés/drapeaux de sensibilité des champs de configuration pour le rendu de l’UI.
- `version` (string) : version du plugin (informationnelle).

## Exigences du schéma JSON

- **Chaque plugin doit fournir un schéma JSON**, même s’il n’accepte aucune configuration.
- Un schéma vide est acceptable (par exemple, `{ "type": "object", "additionalProperties": false }`).
- Les schémas sont validés au moment de la lecture/écriture de la configuration, pas à l’exécution.

## Comportement de validation

- Les clés `channels.*` inconnues sont des **erreurs**, sauf si l’identifiant de canal est déclaré par
  un manifeste de plugin.
- `plugins.entries.<id>`, `plugins.allow`, `plugins.deny` et `plugins.slots.*`
  doivent référencer des identifiants de plugin **découvrables**. Les identifiants inconnus sont des **erreurs**.
- Si un plugin est installé mais possède un manifeste ou un schéma cassé ou manquant,
  la validation échoue et Doctor signale l’erreur de plugin.
- Si une configuration de plugin existe mais que le plugin est **désactivé**, la configuration est conservée et
  un **avertissement** est affiché dans Doctor + les journaux.

## Notes

- Le manifeste est **requis pour tous les plugins**, y compris les chargements depuis le système de fichiers local.
- Le runtime charge toujours le module du plugin séparément ; le manifeste sert uniquement à la
  découverte + la validation.
- Si votre plugin dépend de modules natifs, documentez les étapes de build et toute exigence
  d’autorisation de gestionnaire de paquets (par exemple, pnpm `allow-build-scripts`
  - `pnpm rebuild <package>`).
