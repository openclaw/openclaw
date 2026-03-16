---
summary: "Notes protocole RPC pour assistant onboarding et schéma config"
read_when: "Changement étapes assistant onboarding ou endpoints schéma config"
title: "Protocole Onboarding et Config"
---

# Protocole Onboarding + Config

Objectif : surfaces onboarding + config partagées à travers CLI, app macOS et Web UI.

## Composants

- Moteur wizard (session partagée + prompts + état onboarding).
- Onboarding CLI utilise même flux wizard que clients UI.
- RPC Passerelle expose endpoints wizard + schéma config.
- Onboarding macOS utilise modèle étape wizard.
- Web UI rend formulaires config depuis JSON Schema + hints UI.

## RPC Passerelle

- `wizard.start` params : `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params : `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params : `{ sessionId }`
- `wizard.status` params : `{ sessionId }`
- `config.schema` params : `{}`

Réponses (shape)

- Wizard : `{ sessionId, done, step?, status?, error? }`
- Schéma config : `{ schema, uiHints, version, generatedAt }`

## Hints UI

- `uiHints` keyed par chemin ; métadonnées optionnelles (label/help/group/order/advanced/sensitive/placeholder).
- Champs sensitifs rendent comme inputs password ; pas de couche redaction.
- Nœuds schéma non supportés tombent back vers éditeur JSON raw.

## Notes

- Ce doc est l'endroit unique pour tracker refactors protocole pour onboarding/config.

Voir aussi :

- [Onboarding](/fr-FR/cli/onboard)
- [Configuration](/fr-FR/cli/config)
- [Passerelle](/fr-FR/cli/gateway)
