---
summary: "Configuration Together AI (auth + sélection de modèle)"
read_when:
  - Vous voulez utiliser Together AI avec OpenClaw
  - Vous avez besoin de la variable env de clé API ou du choix auth CLI
---

# Together AI

[Together AI](https://together.ai) fournit l'accès aux principaux modèles open-source incluant Llama, DeepSeek, Kimi, et plus via une API unifiée.

- Fournisseur : `together`
- Auth : `TOGETHER_API_KEY`
- API : Compatible OpenAI

## Démarrage rapide

1. Définissez la clé API (recommandé : stockez-la pour la Passerelle) :

```bash
openclaw onboard --auth-choice together-api-key
```

2. Définissez un modèle par défaut :

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/moonshotai/Kimi-K2.5" },
    },
  },
}
```

## Exemple non interactif

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

Ceci définira `together/moonshotai/Kimi-K2.5` comme modèle par défaut.

## Note sur l'environnement

Si la Passerelle s'exécute comme daemon (launchd/systemd), assurez-vous que `TOGETHER_API_KEY` est disponible pour ce processus (par exemple, dans `~/.clawdbot/.env` ou via `env.shellEnv`).

## Modèles disponibles

Together AI fournit l'accès à de nombreux modèles open-source populaires :

- **GLM 4.7 Fp8** - Modèle par défaut avec fenêtre de contexte 200K
- **Llama 3.3 70B Instruct Turbo** - Suivi d'instructions rapide et efficace
- **Llama 4 Scout** - Modèle de vision avec compréhension d'image
- **Llama 4 Maverick** - Vision et raisonnement avancés
- **DeepSeek V3.1** - Modèle puissant de codage et raisonnement
- **DeepSeek R1** - Modèle de raisonnement avancé
- **Kimi K2 Instruct** - Modèle haute performance avec fenêtre de contexte 262K

Tous les modèles supportent les compléments de discussion standard et sont compatibles avec l'API OpenAI.
