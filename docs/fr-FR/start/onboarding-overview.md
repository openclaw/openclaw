---
summary: "Vue d'ensemble des options et flux d'intégration OpenClaw"
read_when:
  - Choisir un chemin d'intégration
  - Configurer un nouvel environnement
title: "Vue d'ensemble de l'intégration"
sidebarTitle: "Vue d'ensemble de l'intégration"
---

# Vue d'ensemble de l'intégration

OpenClaw prend en charge plusieurs chemins d'intégration selon l'endroit où la passerelle s'exécute et la façon dont vous préférez configurer les fournisseurs.

## Choisissez votre chemin d'intégration

- **Assistant CLI** pour macOS, Linux et Windows (via WSL2).
- **Application macOS** pour une première exécution guidée sur Mac Apple Silicon ou Intel.

## Assistant d'intégration CLI

Exécutez l'assistant dans un terminal :

```bash
openclaw onboard
```

Utilisez l'assistant CLI lorsque vous souhaitez un contrôle total de la passerelle, de l'espace de travail, des canaux et des compétences. Documentation :

- [Assistant d'intégration (CLI)](/fr-FR/start/wizard)
- [Commande `openclaw onboard`](/fr-FR/cli/onboard)

## Intégration de l'application macOS

Utilisez l'application OpenClaw lorsque vous souhaitez une configuration entièrement guidée sur macOS. Documentation :

- [Intégration (application macOS)](/fr-FR/start/onboarding)

## Fournisseur personnalisé

Si vous avez besoin d'un point de terminaison qui n'est pas répertorié, y compris les fournisseurs hébergés qui exposent des API OpenAI ou Anthropic standard, choisissez **Fournisseur personnalisé** dans l'assistant CLI. Il vous sera demandé de :

- Choisir compatible OpenAI, compatible Anthropic ou **Inconnu** (détection automatique).
- Entrer une URL de base et une clé API (si requise par le fournisseur).
- Fournir un ID de modèle et un alias optionnel.
- Choisir un ID de point de terminaison pour que plusieurs points de terminaison personnalisés puissent coexister.

Pour des étapes détaillées, suivez la documentation d'intégration CLI ci-dessus.
