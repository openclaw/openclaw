---
summary: "Référence CLI pour `openclaw configure` (invites de configuration interactives)"
read_when:
  - Vous voulez ajuster les identifiants, appareils ou valeurs par défaut d'agent de manière interactive
title: "configure"
---

# `openclaw configure`

Invite interactive pour configurer les identifiants, appareils et valeurs par défaut d'agent.

Note : La section **Model** inclut maintenant une sélection multiple pour la liste blanche `agents.defaults.models` (ce qui apparaît dans `/model` et le sélecteur de modèle).

Astuce : `openclaw config` sans sous-commande ouvre le même assistant. Utilisez `openclaw config get|set|unset` pour les modifications non interactives.

Connexe :

- Référence de configuration de Passerelle : [Configuration](/fr-FR/gateway/configuration)
- CLI Config : [Config](/fr-FR/cli/config)

Notes :

- Choisir où la Passerelle s'exécute met toujours à jour `gateway.mode`. Vous pouvez sélectionner "Continue" sans autres sections si c'est tout ce dont vous avez besoin.
- Les services orientés canal (Slack/Discord/Matrix/Microsoft Teams) demandent des listes blanches de canal/salon pendant la configuration. Vous pouvez entrer des noms ou des IDs ; l'assistant résout les noms en IDs quand possible.

## Exemples

```bash
openclaw configure
openclaw configure --section models --section channels
```
