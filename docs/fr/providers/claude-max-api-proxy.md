---
summary: "Utiliser un abonnement Claude Max/Pro comme point de terminaison d’API compatible OpenAI"
read_when:
  - Vous souhaitez utiliser un abonnement Claude Max avec des outils compatibles OpenAI
  - Vous souhaitez un serveur d’API local qui encapsule le CLI Claude Code
  - Vous souhaitez economiser de l’argent en utilisant un abonnement plutot que des cles d’API
title: "Proxy d’API Claude Max"
---

# Proxy d’API Claude Max

**claude-max-api-proxy** est un outil communautaire qui expose votre abonnement Claude Max/Pro comme un point de terminaison d’API compatible OpenAI. Cela vous permet d’utiliser votre abonnement avec n’importe quel outil prenant en charge le format d’API OpenAI.

## Pourquoi l’utiliser ?

| Approche              | Coût                                                                                                      | Ideal pour                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| API Anthropic         | Paiement par jeton (~15 $ / M en entree, 75 $ / M en sortie pour Opus) | Applications de production, volume eleve       |
| Abonnement Claude Max | 200 $ / mois, forfait                                                                                     | Usage personnel, developpement, usage illimite |

Si vous avez un abonnement Claude Max et souhaitez l’utiliser avec des outils compatibles OpenAI, ce proxy peut vous faire economiser une somme importante.

## Fonctionnement

```
Your App → claude-max-api-proxy → Claude Code CLI → Anthropic (via subscription)
     (OpenAI format)              (converts format)      (uses your login)
```

Le proxy :

1. Accepte des requetes au format OpenAI sur `http://localhost:3456/v1/chat/completions`
2. Les convertit en commandes du CLI Claude Code
3. Renvoie des reponses au format OpenAI (le streaming est pris en charge)

## Installation

```bash
# Requires Node.js 20+ and Claude Code CLI
npm install -g claude-max-api-proxy

# Verify Claude CLI is authenticated
claude --version
```

## Utilisation

### Demarrer le serveur

```bash
claude-max-api
# Server runs at http://localhost:3456
```

### Le tester

```bash
# Health check
curl http://localhost:3456/health

# List models
curl http://localhost:3456/v1/models

# Chat completion
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Avec OpenClaw

Vous pouvez configurer OpenClaw pour pointer vers le proxy comme point de terminaison personnalise compatible OpenAI :

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

## Modeles disponibles

| ID du modele      | Cartes à        |
| ----------------- | --------------- |
| `claude-opus-4`   | Claude Opus 4   |
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-haiku-4`  | Claude Haiku 4  |

## Demarrage automatique sur macOS

Creez un LaunchAgent pour executer automatiquement le proxy :

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

- **npm :** https://www.npmjs.com/package/claude-max-api-proxy
- **GitHub :** https://github.com/atalovesyou/claude-max-api-proxy
- **Problemes :** https://github.com/atalovesyou/claude-max-api-proxy/issues

## Notes

- Il s’agit d’un **outil communautaire**, non pris en charge officiellement par Anthropic ou OpenClaw
- Necessite un abonnement Claude Max/Pro actif avec le CLI Claude Code authentifie
- Le proxy s’execute localement et n’envoie aucune donnee a des serveurs tiers
- Les reponses en streaming sont entierement prises en charge

## Voir aussi

- [Fournisseur Anthropic](/providers/anthropic) – Integration native OpenClaw avec configuration par setup-token ou cles d’API
- [Fournisseur OpenAI](/providers/openai) – Pour les abonnements OpenAI/Codex
