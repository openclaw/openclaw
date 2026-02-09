---
summary: "Reference CLI pour `openclaw configure` (invites de configuration interactives)"
read_when:
  - Vous souhaitez ajuster interactivement les identifiants, les appareils ou les valeurs par defaut de l’agent
title: "configurer"
---

# `openclaw configure`

Invite interactive pour configurer les identifiants, les appareils et les valeurs par defaut de l’agent.

Remarque : la section **Modele** inclut desormais une selection multiple pour la liste d’autorisation `agents.defaults.models` (ce qui apparait dans `/model` et dans le selecteur de modele).

Astuce : `openclaw config` sans sous-commande ouvre le meme assistant. Utilisez
`openclaw config get|set|unset` pour des modifications non interactives.

Associe :

- Reference de configuration du Gateway (passerelle) : [Configuration](/gateway/configuration)
- CLI de configuration : [Config](/cli/config)

Remarques :

- Le choix de l’emplacement d’execution du Gateway (passerelle) met toujours a jour `gateway.mode`. Vous pouvez selectionner « Continuer » sans autres sections si c’est tout ce dont vous avez besoin.
- Les services orientes canaux (Slack/Discord/Matrix/Microsoft Teams) demandent des listes d’autorisation de canaux/salles lors de la configuration. Vous pouvez saisir des noms ou des ID ; l’assistant resout les noms en ID lorsque c’est possible.

## Exemples

```bash
openclaw configure
openclaw configure --section models --section channels
```
