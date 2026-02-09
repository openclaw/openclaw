---
summary: "Notes de protocole RPC pour l’assistant de prise en main et le schéma de configuration"
read_when: "Modification des étapes de l’assistant de prise en main ou des points de terminaison du schéma de configuration"
title: "Protocole de prise en main et de configuration"
---

# Protocole de prise en main + configuration

Objectif : surfaces partagées de prise en main et de configuration entre la CLI, l’app macOS et l’interface Web.

## Composants

- Moteur d’assistant (session partagée + invites + état de prise en main).
- La prise en main via la CLI utilise le même flux d’assistant que les clients UI.
- La Gateway RPC expose des points de terminaison pour l’assistant et le schéma de configuration.
- La prise en main macOS utilise le modèle d’étapes de l’assistant.
- L’interface Web génère des formulaires de configuration à partir de JSON Schema + indices UI.

## Gateway RPC

- `wizard.start` params : `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params : `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params : `{ sessionId }`
- `wizard.status` params : `{ sessionId }`
- `config.schema` params : `{}`

Réponses (forme)

- Assistant : `{ sessionId, done, step?, status?, error? }`
- Schéma de configuration : `{ schema, uiHints, version, generatedAt }`

## Indices UI

- `uiHints` indexés par chemin ; métadonnées optionnelles (label/aide/groupe/ordre/avancé/sensible/placeholder).
- Les champs sensibles sont rendus comme des champs de mot de passe ; pas de couche de masquage.
- Les nœuds de schéma non pris en charge basculent vers l’éditeur JSON brut.

## Notes

- Ce document est l’unique référence pour suivre les refactorisations de protocole liées à la prise en main et à la configuration.
