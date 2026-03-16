---
summary: "Référence CLI pour `openclaw onboard` (assistant d'intégration interactif)"
read_when:
  - Vous voulez une configuration guidée pour passerelle, espace de travail, auth, canaux et compétences
title: "onboard"
---

# `openclaw onboard`

Assistant d'intégration interactif (configuration de Passerelle locale ou distante).

## Guides connexes

- Hub d'intégration CLI : [Assistant d'Intégration (CLI)](/fr-FR/start/wizard)
- Aperçu d'intégration : [Aperçu d'Intégration](/fr-FR/start/onboarding-overview)
- Référence d'intégration CLI : [Référence d'Intégration CLI](/fr-FR/start/wizard-cli-reference)
- Automatisation CLI : [Automatisation CLI](/fr-FR/start/wizard-cli-automation)
- Intégration macOS : [Intégration (App macOS)](/fr-FR/start/onboarding)

## Exemples

```bash
openclaw onboard
openclaw onboard --flow quickstart
openclaw onboard --flow manual
openclaw onboard --mode remote --remote-url ws://gateway-host:18789
```

Fournisseur personnalisé non interactif :

```bash
openclaw onboard --non-interactive \
  --auth-choice custom-api-key \
  --custom-base-url "https://llm.example.com/v1" \
  --custom-model-id "foo-large" \
  --custom-api-key "$CUSTOM_API_KEY" \
  --custom-compatibility openai
```

`--custom-api-key` est optionnel en mode non interactif. Si omis, l'intégration vérifie `CUSTOM_API_KEY`.

Choix de points de terminaison Z.AI non interactifs :

Note : `--auth-choice zai-api-key` détecte maintenant automatiquement le meilleur point de terminaison Z.AI pour votre clé (préfère l'API générale avec `zai/glm-5`).
Si vous voulez spécifiquement les points de terminaison GLM Coding Plan, choisissez `zai-coding-global` ou `zai-coding-cn`.

```bash
# Sélection de point de terminaison sans invite
openclaw onboard --non-interactive \
  --auth-choice zai-coding-global \
  --zai-api-key "$ZAI_API_KEY"

# Autres choix de points de terminaison Z.AI :
# --auth-choice zai-coding-cn
# --auth-choice zai-global
# --auth-choice zai-cn
```

Notes de flux :

- `quickstart` : invites minimales, génère automatiquement un token de passerelle.
- `manual` : invites complètes pour port/bind/auth (alias de `advanced`).
- Première discussion la plus rapide : `openclaw dashboard` (UI de contrôle, pas de config de canal).
- Fournisseur Personnalisé : connectez n'importe quel point de terminaison compatible OpenAI ou Anthropic, y compris les fournisseurs hébergés non listés. Utilisez Unknown pour auto-détecter.

## Commandes de suivi courantes

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` n'implique pas le mode non interactif. Utilisez `--non-interactive` pour les scripts.
</Note>
