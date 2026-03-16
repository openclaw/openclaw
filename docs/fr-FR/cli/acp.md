---
summary: "Exécuter le pont ACP pour intégrations IDE"
read_when:
  - Configuration intégrations IDE basées ACP
  - Débogage routage session ACP vers Passerelle
title: "acp"
---

# acp

Exécuter le pont ACP (Agent Client Protocol) qui communique avec une Passerelle OpenClaw.

Cette commande parle ACP via stdio pour les IDE et transfère les prompts à la Passerelle via WebSocket. Elle garde les sessions ACP mappées aux clés de session Passerelle.

## Utilisation

```bash
openclaw acp

# Passerelle distante
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attacher à une clé de session existante
openclaw acp --session agent:main:main

# Attacher par étiquette (doit déjà exister)
openclaw acp --session-label "boîte de réception support"

# Réinitialiser la clé de session avant le premier prompt
openclaw acp --session agent:main:main --reset-session
```

## Client ACP (débogage)

Utilisez le client ACP intégré pour vérifier le pont sans IDE. Il génère le pont ACP et vous permet de taper des prompts interactivement.

```bash
openclaw acp client

# Pointer le pont généré vers une Passerelle distante
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Remplacer la commande serveur (par défaut : openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Comment utiliser ceci

Utilisez ACP quand un IDE (ou autre client) parle Agent Client Protocol et vous voulez qu'il pilote une session Passerelle OpenClaw.

1. Assurez-vous que la Passerelle fonctionne (locale ou distante).
2. Configurez la cible Passerelle (config ou drapeaux).
3. Pointez votre IDE pour exécuter `openclaw acp` via stdio.

Exemple de config (persistée) :

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Exemple d'exécution directe (pas d'écriture de config) :

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Sélection d'agents

ACP ne choisit pas directement les agents. Il route par la clé de session Passerelle.

Utilisez des clés de session limitées à l'agent pour cibler un agent spécifique :

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Chaque session ACP mappe à une seule clé de session Passerelle. Un agent peut avoir plusieurs sessions ; ACP utilise par défaut une session isolée `acp:<uuid>` sauf si vous remplacez la clé ou l'étiquette.

## Configuration de l'éditeur Zed

Ajoutez un agent ACP personnalisé dans `~/.config/zed/settings.json` (ou utilisez l'UI Paramètres Zed) :

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

## Voir aussi

- [Protocole de la Passerelle](/fr-FR/gateway/protocol)
- [Configuration](/fr-FR/gateway/configuration)
- [Sessions](/fr-FR/concepts/sessions)
