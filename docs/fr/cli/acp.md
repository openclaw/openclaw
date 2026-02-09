---
summary: "Exécuter le pont ACP pour les integrations d’IDE"
read_when:
  - Mise en place d’integrations d’IDE basees sur ACP
  - Debogage du routage des sessions ACP vers la Gateway (passerelle)
title: "acp"
---

# acp

Exécute le pont ACP (Agent Client Protocol) qui communique avec une Gateway (passerelle) OpenClaw.

Cette commande parle ACP via stdio pour les IDE et transfere les invites vers la Gateway
via WebSocket. Elle conserve les sessions ACP associees aux cles de session de la Gateway.

## Usage

```bash
openclaw acp

# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>

# Attach to an existing session key
openclaw acp --session agent:main:main

# Attach by label (must already exist)
openclaw acp --session-label "support inbox"

# Reset the session key before the first prompt
openclaw acp --session agent:main:main --reset-session
```

## Client ACP (debug)

Utilisez le client ACP integre pour verifier le pont sans IDE.
Il lance le pont ACP et vous permet de saisir des invites de maniere interactive.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Comment utiliser ceci

Utilisez ACP lorsqu’un IDE (ou un autre client) parle Agent Client Protocol et que vous souhaitez
qu’il pilote une session de Gateway (passerelle) OpenClaw.

1. Assurez-vous que la Gateway est en cours d’execution (locale ou distante).
2. Configurez la cible de la Gateway (configuration ou indicateurs).
3. Indiquez a votre IDE d’executer `openclaw acp` via stdio.

Exemple de configuration (persistante) :

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Exemple d’execution directe (sans ecriture de configuration) :

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selection des agents

ACP ne selectionne pas directement les agents. Il achemine via la cle de session de la Gateway.

Utilisez des cles de session scopees par agent pour cibler un agent specifique :

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Chaque session ACP correspond a une seule cle de session de la Gateway. Un agent peut avoir de nombreuses
sessions ; par defaut, ACP utilise une session `acp:<uuid>` isolee, sauf si vous remplacez
la cle ou le libelle.

## Configuration de l’editeur Zed

Ajoutez un agent ACP personnalise dans `~/.config/zed/settings.json` (ou utilisez l’interface des parametres de Zed) :

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

Pour cibler une Gateway ou un agent specifique :

```json
{
  "agent_servers": {
    "OpenClaw ACP": {
      "type": "custom",
      "command": "openclaw",
      "args": [
        "acp",
        "--url",
        "wss://gateway-host:18789",
        "--token",
        "<token>",
        "--session",
        "agent:design:main"
      ],
      "env": {}
    }
  }
}
```

Dans Zed, ouvrez le panneau Agent et selectionnez « OpenClaw ACP » pour demarrer un fil.

## Correspondance des sessions

Par defaut, les sessions ACP obtiennent une cle de session de Gateway isolee avec un prefixe `acp:`.
Pour reutiliser une session connue, passez une cle ou un libelle de session :

- `--session <key>` : utiliser une cle de session de Gateway specifique.
- `--session-label <label>` : resoudre une session existante par libelle.
- `--reset-session` : creer un nouvel identifiant de session pour cette cle (meme cle, nouvelle transcription).

Si votre client ACP prend en charge les metadonnees, vous pouvez remplacer par session :

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Pour en savoir plus sur les cles de session, consultez [/concepts/session](/concepts/session).

## Options

- `--url <url>` : URL WebSocket de la Gateway (par defaut, gateway.remote.url lorsqu’elle est configuree).
- `--token <token>` : jeton d’authentification de la Gateway.
- `--password <password>` : mot de passe d’authentification de la Gateway.
- `--session <key>` : cle de session par defaut.
- `--session-label <label>` : libelle de session par defaut a resoudre.
- `--require-existing` : echouer si la cle/le libelle de session n’existe pas.
- `--reset-session` : reinitialiser la cle de session avant la premiere utilisation.
- `--no-prefix-cwd` : ne pas prefixer les invites avec le repertoire de travail.
- `--verbose, -v` : journalisation verbeuse vers stderr.

### Options `acp client`

- `--cwd <dir>` : repertoire de travail pour la session ACP.
- `--server <command>` : commande du serveur ACP (par defaut : `openclaw`).
- `--server-args <args...>` : arguments supplementaires passes au serveur ACP.
- `--server-verbose` : activer la journalisation verbeuse sur le serveur ACP.
- `--verbose, -v` : journalisation verbeuse du client.
