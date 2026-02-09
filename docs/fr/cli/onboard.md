---
summary: "Reference CLI pour `openclaw onboard` (assistant de prise en main interactif)"
read_when:
  - Vous souhaitez une configuration guidee pour la passerelle, l'espace de travail, l'authentification, les canaux et les Skills
title: "onboard"
---

# `openclaw onboard`

Assistant de prise en main interactif (configuration de la Gateway (passerelle) locale ou distante).

## Guides associes

- Hub de prise en main CLI : [Onboarding Wizard (CLI)](/start/wizard)
- Reference de prise en main CLI : [CLI Onboarding Reference](/start/wizard-cli-reference)
- Automatisation CLI : [CLI Automation](/start/wizard-cli-automation)
- Prise en main macOS : [Onboarding (macOS App)](/start/onboarding)

## Exemples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Notes de flux :

- `quickstart` : invites minimales, genere automatiquement un jeton de passerelle.
- `manual` : invites completes pour port/liaison/authentification (alias de `advanced`).
- Premier chat le plus rapide : `openclaw dashboard` (UI de controle, aucune configuration de canal).

## Commandes de suivi courantes

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` n'implique pas un mode non interactif. Utilisez `--non-interactive` pour les scripts.
</Note>
