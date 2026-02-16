---
summary: "Utiliser souscription Claude Max/Pro comme endpoint API compatible OpenAI"
read_when:
  - Vous voulez utiliser souscription Claude Max avec tools compatibles OpenAI
  - Vous voulez serveur API local qui wrap Claude Code CLI
  - Vous voulez économiser argent en utilisant souscription au lieu clés API
title: "Proxy API Claude Max"
---

# Proxy API Claude Max

**claude-max-api-proxy** est tool communautaire qui expose votre souscription Claude Max/Pro comme endpoint API compatible OpenAI. Cela permet utiliser votre souscription avec n'importe quel tool supportant format API OpenAI.

## Pourquoi Utiliser Ceci ?

| Approche                | Coût                                                  | Meilleur Pour                        |
| ----------------------- | ----------------------------------------------------- | ------------------------------------ |
| API Anthropic           | Payé per token (~$15/M input, $75/M output pour Opus) | Apps production, volume élevé        |
| Souscription Claude Max | $200/mois forfait                                     | Usage personnel, dev, usage illimité |

Si vous avez souscription Claude Max et voulez l'utiliser avec tools compatibles OpenAI, ce proxy peut vous faire économiser argent significatif.

## Comment Ça Fonctionne

```
Votre App → claude-max-api-proxy → Claude Code CLI → Anthropic (via souscription)
     (format OpenAI)              (convertit format)      (utilise votre login)
```

Proxy :

1. Accepte requêtes format OpenAI à `http://localhost:3456/v1/chat/completions`
2. Les convertit en commandes Claude Code CLI
3. Retourne réponses en format OpenAI (streaming supporté)

## Installation

```bash
# Requiert Node.js 20+ et Claude Code CLI
npm install -g claude-max-api-proxy

# Vérifier Claude CLI authentifié
claude --version
```

## Usage

### Démarrer serveur

```bash
claude-max-api
# Serveur tourne à http://localhost:3456
```

### Tester

```bash
# Health check
curl http://localhost:3456/health

# Lister modèles
curl http://localhost:3456/v1/models

# Completion chat
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Bonjour!"}]
  }'
```

### Avec OpenClaw

Vous pouvez pointer OpenClaw vers proxy comme endpoint compatible OpenAI custom :

```json5
{
  env: {
    OPENAI_API_KEY: "not-needed",
    OPENAI_BASE_URL: "http://localhost:3456/v1",
  },
  agents: {
    defaults: {
      model: { primary: "openai/claude-opus-4" },
    },
  },
}
```

## Modèles Disponibles

| ID Modèle         | Mappe Vers      |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Auto-Start sur macOS

Créez LaunchAgent pour exécuter proxy automatiquement :

```bash
cat > ~/Library/LaunchAgents/com.claude-max-api.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-max-api</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/claude-max-api-proxy/dist/server/standalone.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:~/.local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claude-max-api.plist
```

## Liens

- **npm :** [https://www.npmjs.com/package/claude-max-api-proxy](https://www.npmjs.com/package/claude-max-api-proxy)
- **GitHub :** [https://github.com/atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy)
- **Issues :** [https://github.com/atalovesyou/claude-max-api-proxy/issues](https://github.com/atalovesyou/claude-max-api-proxy/issues)

## Notes

- Ceci est **tool communautaire**, pas officiellement supporté par Anthropic ou OpenClaw
- Requiert souscription Claude Max/Pro active avec Claude Code CLI authentifié
- Proxy tourne localement et n'envoie pas données vers serveurs tiers
- Réponses streaming complètement supportées

## Dépannage

**Erreur "Claude CLI not found" :**

```bash
# Vérifier Claude CLI installé
which claude

# Installer si manquant
npm install -g @anthropic-ai/claude-code-cli
```

**Erreur "Not authenticated" :**

```bash
# Login Claude CLI
claude auth login
```

**Port 3456 déjà utilisé :**

```bash
# Changer port
PORT=3457 claude-max-api
```

Puis mettez à jour `OPENAI_BASE_URL` dans config OpenClaw.

Voir aussi :

- [Provider Anthropic](/fr-FR/providers/anthropic) - Intégration native OpenClaw avec setup-token Claude ou clés API
- [Provider OpenAI](/fr-FR/providers/openai) - Pour souscriptions OpenAI/Codex
- [Modèles](/fr-FR/concepts/models)
