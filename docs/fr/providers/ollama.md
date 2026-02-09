---
summary: "Exécuter OpenClaw avec Ollama (runtime LLM local)"
read_when:
  - Vous souhaitez exécuter OpenClaw avec des modèles locaux via Ollama
  - Vous avez besoin d’aide pour la configuration et la mise en place d’Ollama
title: "Ollama"
---

# Ollama

Ollama est un runtime LLM local qui facilite l’exécution de modèles open source sur votre machine. OpenClaw s’intègre à l’API compatible OpenAI d’Ollama et peut **découvrir automatiquement les modèles compatibles avec les outils** lorsque vous optez pour `OLLAMA_API_KEY` (ou un profil d’authentification) et que vous ne définissez pas d’entrée `models.providers.ollama` explicite.

## Demarrage rapide

1. Installez Ollama : https://ollama.ai

2. Téléchargez un modèle :

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. Activez Ollama pour OpenClaw (n’importe quelle valeur fonctionne ; Ollama ne nécessite pas de vraie clé) :

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Utilisez les modèles Ollama :

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Decouverte des modèles (fournisseur implicite)

Lorsque vous définissez `OLLAMA_API_KEY` (ou un profil d’authentification) et que vous **ne** définissez **pas** `models.providers.ollama`, OpenClaw découvre les modèles depuis l’instance Ollama locale à `http://127.0.0.1:11434` :

- Interroge `/api/tags` et `/api/show`
- Conserve uniquement les modèles qui signalent la capacité `tools`
- Marque `reasoning` lorsque le modèle signale `thinking`
- Lit `contextWindow` depuis `model_info["<arch>.context_length"]` lorsque disponible
- Définit `maxTokens` à 10× la fenêtre de contexte
- Définit tous les coûts à `0`

Cela évite les entrées de modèles manuelles tout en maintenant le catalogue aligné sur les capacités d’Ollama.

Pour voir quels modèles sont disponibles :

```bash
ollama list
openclaw models list
```

Pour ajouter un nouveau modèle, il suffit de le télécharger avec Ollama :

```bash
ollama pull mistral
```

Le nouveau modèle sera automatiquement découvert et disponible à l’utilisation.

Si vous définissez `models.providers.ollama` explicitement, la découverte automatique est ignorée et vous devez définir les modèles manuellement (voir ci-dessous).

## Configuration

### Configuration de base (découverte implicite)

La manière la plus simple d’activer Ollama est via une variable d’environnement :

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Configuration explicite (modèles manuels)

Utilisez une configuration explicite lorsque :

- Ollama s’exécute sur un autre hôte/port.
- Vous souhaitez forcer des fenêtres de contexte spécifiques ou des listes de modèles.
- Vous souhaitez inclure des modèles qui ne signalent pas la prise en charge des outils.

```json5
{
  models: {
    providers: {
      ollama: {
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

Si `OLLAMA_API_KEY` est défini, vous pouvez omettre `apiKey` dans l’entrée du fournisseur et OpenClaw le renseignera pour les vérifications de disponibilité.

### URL de base personnalisée (configuration explicite)

Si Ollama s’exécute sur un hôte ou un port différent (la configuration explicite désactive la découverte automatique, donc définissez les modèles manuellement) :

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

### Sélection des modèles

Une fois configurés, tous vos modèles Ollama sont disponibles :

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## Avancé

### Modèles de raisonnement

OpenClaw marque les modèles comme capables de raisonnement lorsque Ollama signale `thinking` dans `/api/show` :

```bash
ollama pull deepseek-r1:32b
```

### Coûts des modèles

Ollama est gratuit et s’exécute localement, donc tous les coûts des modèles sont définis à 0 $.

### Configuration du streaming

En raison d’un [problème connu](https://github.com/badlogic/pi-mono/issues/1205) dans le SDK sous-jacent avec le format de réponse d’Ollama, **le streaming est désactivé par défaut** pour les modèles Ollama. Cela évite des réponses corrompues lors de l’utilisation de modèles compatibles avec les outils.

Lorsque le streaming est désactivé, les réponses sont livrées en une seule fois (mode non streaming), ce qui évite le problème où des deltas de contenu/de raisonnement intercalés provoquent une sortie brouillée.

#### Réactiver le streaming (avancé)

Si vous souhaitez réactiver le streaming pour Ollama (peut provoquer des problèmes avec les modèles compatibles avec les outils) :

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### Désactiver le streaming pour d’autres fournisseurs

Vous pouvez également désactiver le streaming pour n’importe quel fournisseur si nécessaire :

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

### Fenêtres de contexte

Pour les modèles découverts automatiquement, OpenClaw utilise la fenêtre de contexte signalée par Ollama lorsqu’elle est disponible, sinon la valeur par défaut est `8192`. Vous pouvez remplacer `contextWindow` et `maxTokens` dans la configuration explicite du fournisseur.

## Problemes courants

### Ollama non détecté

Assurez-vous qu’Ollama est en cours d’exécution et que vous avez défini `OLLAMA_API_KEY` (ou un profil d’authentification), et que vous n’avez **pas** défini d’entrée `models.providers.ollama` explicite :

```bash
ollama serve
```

Et que l’API est accessible :

```bash
curl http://localhost:11434/api/tags
```

### Aucun modèle disponible

OpenClaw ne découvre automatiquement que les modèles qui signalent la prise en charge des outils. Si votre modèle n’apparaît pas, soit :

- Téléchargez un modèle compatible avec les outils, ou
- Définissez le modèle explicitement dans `models.providers.ollama`.

Pour ajouter des modèles :

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Connexion refusée

Vérifiez qu’Ollama s’exécute sur le bon port :

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Réponses corrompues ou noms d’outils dans la sortie

Si vous voyez des réponses brouillées contenant des noms d’outils (comme `sessions_send`, `memory_get`) ou du texte fragmenté lors de l’utilisation de modèles Ollama, cela est dû à un problème du SDK en amont avec les réponses en streaming. **Ceci est corrigé par défaut** dans la dernière version d’OpenClaw en désactivant le streaming pour les modèles Ollama.

Si vous avez activé manuellement le streaming et que vous rencontrez ce problème :

1. Supprimez la configuration `streaming: true` de vos entrées de modèles Ollama, ou
2. Définissez explicitement `streaming: false` pour les modèles Ollama (voir [Configuration du streaming](#configuration-du-streaming))

## Voir aussi

- [Fournisseurs de modèles](/concepts/model-providers) - Vue d’ensemble de tous les fournisseurs
- [Sélection des modèles](/concepts/models) - Comment choisir des modèles
- [Configuration](/gateway/configuration) - Référence complète de la configuration
