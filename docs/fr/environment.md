---
summary: "Où OpenClaw charge les variables d'environnement et l'ordre de priorité"
read_when:
  - Vous devez savoir quelles variables d'environnement sont chargées et dans quel ordre
  - Vous dépannez des clés API manquantes dans la Gateway (passerelle)
  - Vous documentez l'authentification des fournisseurs ou les environnements de déploiement
title: "Variables d'environnement"
x-i18n:
  source_path: environment.md
  source_hash: b49ae50e5d306612
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T07:01:27Z
---

# Variables d'environnement

OpenClaw récupère les variables d'environnement à partir de plusieurs sources. La règle est de **ne jamais remplacer des valeurs existantes**.

## Priorité (la plus élevée → la plus faible)

1. **Environnement du processus** (ce que le processus de la Gateway possède déjà depuis le shell ou le démon parent).
2. **`.env` dans le répertoire de travail courant** (valeur par défaut dotenv ; ne remplace pas).
3. **`.env` global** à `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env` ; ne remplace pas).
4. **Bloc `env` de configuration** dans `~/.openclaw/openclaw.json` (appliqué uniquement s'il manque).
5. **Import facultatif du shell de connexion** (`env.shellEnv.enabled` ou `OPENCLAW_LOAD_SHELL_ENV=1`), appliqué uniquement pour les clés attendues manquantes.

Si le fichier de configuration est entièrement absent, l'étape 4 est ignorée ; l'import du shell s'exécute toujours s'il est activé.

## Bloc de configuration `env`

Deux méthodes équivalentes pour définir des variables d'environnement en ligne (toutes deux sans remplacement) :

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

## Import des variables d'environnement du shell

`env.shellEnv` lance votre shell de connexion et importe uniquement les clés attendues **manquantes** :

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Équivalents en variables d'environnement :

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Substitution de variables d'environnement dans la configuration

Vous pouvez référencer directement des variables d'environnement dans les valeurs de chaîne de la configuration en utilisant la syntaxe `${VAR_NAME}` :

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

Voir [Configuration : Substitution des variables d'environnement](/gateway/configuration#env-var-substitution-in-config) pour plus de détails.

## Liens connexes

- [Configuration de la Gateway](/gateway/configuration)
- [FAQ : variables d'environnement et chargement de .env](/help/faq#env-vars-and-env-loading)
- [Aperçu des modèles](/concepts/models)
