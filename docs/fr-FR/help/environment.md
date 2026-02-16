---
summary: "Où OpenClaw charge les variables d'environnement et l'ordre de préséance"
read_when:
  - Vous devez savoir quelles variables d'environnement sont chargées, et dans quel ordre
  - Vous déboguez des clés API manquantes dans la Passerelle
  - Vous documentez l'authentification des fournisseurs ou les environnements de déploiement
title: "Variables d'environnement"
---

# Variables d'environnement

OpenClaw récupère les variables d'environnement depuis plusieurs sources. La règle est **ne jamais écraser les valeurs existantes**.

## Préséance (la plus haute → la plus basse)

1. **Environnement du processus** (ce que le processus de Passerelle a déjà depuis le shell/daemon parent).
2. **`.env` dans le répertoire de travail actuel** (dotenv par défaut ; n'écrase pas).
3. **`.env` global** à `~/.openclaw/.env` (alias `$OPENCLAW_STATE_DIR/.env` ; n'écrase pas).
4. **Bloc `env` de config** dans `~/.openclaw/openclaw.json` (appliqué seulement si manquant).
5. **Import optionnel du shell de connexion** (`env.shellEnv.enabled` ou `OPENCLAW_LOAD_SHELL_ENV=1`), appliqué seulement pour les clés attendues manquantes.

Si le fichier de config manque entièrement, l'étape 4 est sautée ; l'import shell fonctionne toujours s'il est activé.

## Bloc `env` de config

Deux façons équivalentes de définir des variables d'environnement inline (les deux sont non-écrasantes) :

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

## Import shell env

`env.shellEnv` exécute votre shell de connexion et importe seulement les clés attendues **manquantes** :

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

Équivalents de variable d'environnement :

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## Substitution de variable d'environnement dans la config

Vous pouvez référencer directement des variables d'environnement dans les valeurs de chaîne de config en utilisant la syntaxe `${VAR_NAME}` :

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

Voir [Configuration : Substitution de variable d'environnement](/fr-FR/gateway/configuration#env-var-substitution-in-config) pour tous les détails.

## Variables d'environnement liées aux chemins

| Variable               | Objectif                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | Remplace le répertoire d'accueil utilisé pour toute résolution de chemin interne (`~/.openclaw/`, répertoires d'agent, sessions, identifiants). Utile lors de l'exécution d'OpenClaw en tant qu'utilisateur de service dédié. |
| `OPENCLAW_STATE_DIR`   | Remplace le répertoire d'état (par défaut `~/.openclaw`).                                                                                                                                                                     |
| `OPENCLAW_CONFIG_PATH` | Remplace le chemin du fichier de config (par défaut `~/.openclaw/openclaw.json`).                                                                                                                                             |

### `OPENCLAW_HOME`

Quand définie, `OPENCLAW_HOME` remplace le répertoire d'accueil système (`$HOME` / `os.homedir()`) pour toute résolution de chemin interne. Cela permet une isolation complète du système de fichiers pour les comptes de service headless.

**Préséance :** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**Exemple** (macOS LaunchDaemon) :

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`OPENCLAW_HOME` peut aussi être défini à un chemin tilde (ex. `~/svc`), qui est étendu en utilisant `$HOME` avant utilisation.

## Connexe

- [Configuration de passerelle](/fr-FR/gateway/configuration)
- [FAQ : variables d'environnement et chargement .env](/fr-FR/help/faq#env-vars-and-env-loading)
- [Vue d'ensemble des modèles](/fr-FR/concepts/models)
