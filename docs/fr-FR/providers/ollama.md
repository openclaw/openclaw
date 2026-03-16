---
summary: "Exécuter OpenClaw avec Ollama (runtime LLM local)"
read_when:
  - Vous voulez exécuter OpenClaw avec des modèles locaux via Ollama
  - Vous avez besoin de conseils de configuration et d'installation Ollama
title: "Ollama"
---

# Ollama

Ollama est un runtime LLM local qui facilite l'exécution de modèles open-source sur votre machine. OpenClaw s'intègre avec l'API native d'Ollama (`/api/chat`), supportant le streaming et l'appel d'outil, et peut **auto-découvrir les modèles capables d'outils** quand vous optez avec `OLLAMA_API_KEY` (ou un profil auth) et ne définissez pas d'entrée `models.providers.ollama` explicite.

## Démarrage rapide

1. Installez Ollama : [https://ollama.ai](https://ollama.ai)

2. Tirez un modèle :

```bash
ollama pull gpt-oss:20b
# ou
ollama pull llama3.3
# ou
ollama pull qwen2.5-coder:32b
# ou
ollama pull deepseek-r1:32b
```

3. Activez Ollama pour OpenClaw (n'importe quelle valeur fonctionne ; Ollama ne nécessite pas une vraie clé) :

```bash
# Définir variable d'environnement
export OLLAMA_API_KEY="ollama-local"

# Ou configurer dans votre fichier config
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Utilisez les modèles Ollama :

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Découverte de modèle (fournisseur implicite)

Quand vous définissez `OLLAMA_API_KEY` (ou un profil auth) et **ne définissez pas** `models.providers.ollama`, OpenClaw découvre les modèles depuis l'instance Ollama locale à `http://127.0.0.1:11434` :

- Interroge `/api/tags` et `/api/show`
- Garde seulement les modèles qui signalent la capacité `tools`
- Marque `reasoning` quand le modèle signale `thinking`
- Lit `contextWindow` depuis `model_info["<arch>.context_length"]` quand disponible
- Définit `maxTokens` à 10× la fenêtre de contexte
- Définit tous les coûts à `0`

Cela évite les entrées de modèle manuelles tout en gardant le catalogue aligné avec les capacités d'Ollama.

Pour voir quels modèles sont disponibles :

```bash
ollama list
openclaw models list
```

Pour ajouter un nouveau modèle, tirez-le simplement avec Ollama :

```bash
ollama pull mistral
```

Le nouveau modèle sera automatiquement découvert et disponible à l'utilisation.

Si vous définissez `models.providers.ollama` explicitement, l'auto-découverte est ignorée et vous devez définir les modèles manuellement (voir ci-dessous).

## Configuration

### Configuration de base (découverte implicite)

La façon la plus simple d'activer Ollama est via variable d'environnement :

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Configuration explicite (modèles manuels)

Utilisez la config explicite quand :

- Ollama s'exécute sur un autre hôte/port.
- Vous voulez forcer des fenêtres de contexte spécifiques ou des listes de modèles.
- Vous voulez inclure des modèles qui ne signalent pas le support d'outil.

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://hôte-ollama:11434",
        apiKey: "ollama-local",
        api: "ollama",
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

Si `OLLAMA_API_KEY` est défini, vous pouvez omettre `apiKey` dans l'entrée de fournisseur et OpenClaw le remplira pour les vérifications de disponibilité.

### URL de base personnalisée (config explicite)

Si Ollama s'exécute sur un hôte ou port différent (la config explicite désactive l'auto-découverte, donc définissez les modèles manuellement) :

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://hôte-ollama:11434",
      },
    },
  },
}
```

### Sélection de modèle

Une fois configuré, tous vos modèles Ollama sont disponibles :

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

OpenClaw marque les modèles comme capables de raisonnement quand Ollama signale `thinking` dans `/api/show` :

```bash
ollama pull deepseek-r1:32b
```

### Coûts de modèle

Ollama est gratuit et s'exécute localement, donc tous les coûts de modèle sont définis à $0.

### Configuration de streaming

L'intégration Ollama d'OpenClaw utilise l'**API native Ollama** (`/api/chat`) par défaut, qui supporte pleinement le streaming et l'appel d'outil simultanément. Aucune configuration spéciale n'est nécessaire.

#### Mode compatible OpenAI hérité

Si vous devez utiliser le point de terminaison compatible OpenAI à la place (par ex., derrière un proxy qui supporte seulement le format OpenAI), définissez `api: "openai-completions"` explicitement :

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://hôte-ollama:11434/v1",
        api: "openai-completions",
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

Note : Le point de terminaison compatible OpenAI peut ne pas supporter le streaming + appel d'outil simultanément. Vous devrez peut-être désactiver le streaming avec `params: { streaming: false }` dans la config de modèle.

### Fenêtres de contexte

Pour les modèles auto-découverts, OpenClaw utilise la fenêtre de contexte signalée par Ollama quand disponible, sinon il utilise par défaut `8192`. Vous pouvez remplacer `contextWindow` et `maxTokens` dans la config de fournisseur explicite.

## Dépannage

### Ollama non détecté

Assurez-vous qu'Ollama s'exécute et que vous avez défini `OLLAMA_API_KEY` (ou un profil auth), et que vous n'avez **pas** défini une entrée `models.providers.ollama` explicite :

```bash
ollama serve
```

Et que l'API est accessible :

```bash
curl http://localhost:11434/api/tags
```

### Aucun modèle disponible

OpenClaw auto-découvre seulement les modèles qui signalent le support d'outil. Si votre modèle n'est pas listé, soit :

- Tirez un modèle capable d'outil, ou
- Définissez le modèle explicitement dans `models.providers.ollama`.

Pour ajouter des modèles :

```bash
ollama list  # Voir ce qui est installé
ollama pull gpt-oss:20b  # Tirer un modèle capable d'outil
ollama pull llama3.3     # Ou un autre modèle
```

### Connexion refusée

Vérifiez qu'Ollama s'exécute sur le port correct :

```bash
# Vérifier si Ollama s'exécute
ps aux | grep ollama

# Ou redémarrer Ollama
ollama serve
```

## Voir aussi

- [Fournisseurs de Modèle](/fr-FR/concepts/model-providers) - Aperçu de tous les fournisseurs
- [Sélection de Modèle](/fr-FR/concepts/models) - Comment choisir des modèles
- [Configuration](/fr-FR/gateway/configuration) - Référence de config complète
