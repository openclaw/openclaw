---
summary: "Utilisez l'API unifiée de Qianfan pour accéder à de nombreux modèles dans OpenClaw"
read_when:
  - Vous voulez une seule clé API pour plusieurs LLMs
  - Vous avez besoin de conseils de configuration Baidu Qianfan
title: "Qianfan"
---

# Guide du Fournisseur Qianfan

Qianfan est la plateforme MaaS de Baidu, fournit une **API unifiée** qui route les requêtes vers de nombreux modèles derrière un seul point de terminaison et une clé API. Il est compatible OpenAI, donc la plupart des SDKs OpenAI fonctionnent en changeant l'URL de base.

## Prérequis

1. Un compte Baidu Cloud avec accès API Qianfan
2. Une clé API depuis la console Qianfan
3. OpenClaw installé sur votre système

## Obtenir votre clé API

1. Visitez la [Console Qianfan](https://console.bce.baidu.com/qianfan/ais/console/apiKey)
2. Créez une nouvelle application ou sélectionnez-en une existante
3. Générez une clé API (format : `bce-v3/ALTAK-...`)
4. Copiez la clé API pour utilisation avec OpenClaw

## Configuration CLI

```bash
openclaw onboard --auth-choice qianfan-api-key
```

## Documentation connexe

- [Configuration OpenClaw](/fr-FR/gateway/configuration)
- [Fournisseurs de Modèles](/fr-FR/concepts/model-providers)
- [Configuration Agent](/fr-FR/concepts/agent)
- [Documentation API Qianfan](https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb)
