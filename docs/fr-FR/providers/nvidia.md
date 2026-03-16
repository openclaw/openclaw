---
summary: "Utilisez l'API compatible OpenAI de NVIDIA dans OpenClaw"
read_when:
  - Vous voulez utiliser des modèles NVIDIA dans OpenClaw
  - Vous avez besoin de la configuration NVIDIA_API_KEY
title: "NVIDIA"
---

# NVIDIA

NVIDIA fournit une API compatible OpenAI à `https://integrate.api.nvidia.com/v1` pour les modèles Nemotron et NeMo. Authentifiez-vous avec une clé API de [NVIDIA NGC](https://catalog.ngc.nvidia.com/).

## Configuration CLI

Exportez la clé une fois, puis exécutez l'intégration et définissez un modèle NVIDIA :

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

Si vous passez toujours `--token`, rappelez-vous qu'il atterrit dans l'historique shell et la sortie `ps` ; préférez la variable env quand possible.

## Extrait de config

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## IDs de modèle

- `nvidia/llama-3.1-nemotron-70b-instruct` (par défaut)
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## Notes

- Point de terminaison `/v1` compatible OpenAI ; utilisez une clé API de NVIDIA NGC.
- Le fournisseur s'active automatiquement quand `NVIDIA_API_KEY` est défini ; utilise des défauts statiques (fenêtre de contexte de 131 072 tokens, 4 096 tokens max).
