---
summary: "Interface des parametres des Skills macOS et etat base sur la Gateway (passerelle)"
read_when:
  - Mise a jour de l'interface des parametres des Skills macOS
  - Modification des regles de controle ou du comportement d'installation des Skills
title: "Skills"
---

# Skills (macOS)

L'application macOS expose les Skills OpenClaw via la Gateway (passerelle) ; elle n'analyse pas les Skills localement.

## Source de donnees

- `skills.status` (Gateway) renvoie tous les Skills ainsi que l'eligibilite et les exigences manquantes
  (y compris les blocages par allowlist pour les Skills integres).
- Les exigences sont derivees de `metadata.openclaw.requires` dans chaque `SKILL.md`.

## Actions d'installation

- `metadata.openclaw.install` definit les options d'installation (brew/node/go/uv).
- L'application appelle `skills.install` pour executer les installateurs sur l'hote de la Gateway.
- La Gateway n'expose qu'un seul installateur prefere lorsque plusieurs sont fournis
  (brew lorsqu'il est disponible, sinon le gestionnaire node de `skills.install`, npm par defaut).

## Clés Env/API

- L'application stocke les cles dans `~/.openclaw/openclaw.json` sous `skills.entries.<skillKey>`.
- `skills.update` met a jour `enabled`, `apiKey` et `env`.

## Mode distant

- L'installation et les mises a jour de configuration ont lieu sur l'hote de la Gateway (et non sur le Mac local).
