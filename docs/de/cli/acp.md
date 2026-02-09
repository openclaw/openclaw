---
summary: "„Ausführen der ACP-Brücke für IDE-Integrationen“"
read_when:
  - Einrichten von ACP-basierten IDE-Integrationen
  - Debuggen des ACP-Sitzungsroutings zum Gateway
title: "acp"
---

# acp

Startet die ACP‑Brücke (Agent Client Protocol), die mit einem OpenClaw Gateway kommuniziert.

Dieser Befehl spricht ACP über stdio für IDEs und leitet Prompts über WebSocket an das Gateway weiter. Er hält ACP‑Sitzungen auf Gateway‑Sitzungsschlüssel abgebildet.

## Verwendung

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

## ACP‑Client (Debug)

Verwenden Sie den integrierten ACP‑Client, um die Brücke ohne IDE zu überprüfen.
Er startet die ACP‑Brücke und ermöglicht es Ihnen, Prompts interaktiv einzugeben.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Verwendung

Verwenden Sie ACP, wenn eine IDE (oder ein anderer Client) das Agent Client Protocol spricht und damit eine OpenClaw‑Gateway‑Sitzung steuern soll.

1. Stellen Sie sicher, dass das Gateway läuft (lokal oder remote).
2. Konfigurieren Sie das Gateway‑Ziel (Konfiguration oder Flags).
3. Richten Sie Ihre IDE so ein, dass sie `openclaw acp` über stdio ausführt.

Beispielkonfiguration (persistiert):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Beispiel für direkte Ausführung (keine Konfiguration schreiben):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Agenten auswählen

ACP wählt Agenten nicht direkt aus. Das Routing erfolgt über den Gateway‑Sitzungsschlüssel.

Verwenden Sie agentenspezifische Sitzungsschlüssel, um einen bestimmten Agenten anzusteuern:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Jede ACP‑Sitzung ist einem einzelnen Gateway‑Sitzungsschlüssel zugeordnet. Ein Agent kann viele Sitzungen haben; ACP verwendet standardmäßig eine isolierte `acp:<uuid>`‑Sitzung, sofern Sie den Schlüssel oder das Label nicht überschreiben.

## Zed‑Editor‑Einrichtung

Fügen Sie einen benutzerdefinierten ACP‑Agenten in `~/.config/zed/settings.json` hinzu (oder verwenden Sie die Einstellungs‑UI von Zed):

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

So zielen Sie auf ein bestimmtes Gateway oder einen Agenten:

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

Öffnen Sie in Zed das Agent‑Panel und wählen Sie „OpenClaw ACP“, um einen Thread zu starten.

## Sitzungszuordnung

Standardmäßig erhalten ACP‑Sitzungen einen isolierten Gateway‑Sitzungsschlüssel mit dem Präfix `acp:`.
Um eine bekannte Sitzung wiederzuverwenden, übergeben Sie einen Sitzungsschlüssel oder ein Label:

- `--session <key>`: einen bestimmten Gateway‑Sitzungsschlüssel verwenden.
- `--session-label <label>`: eine bestehende Sitzung anhand des Labels auflösen.
- `--reset-session`: eine neue Sitzungs‑ID für diesen Schlüssel erzeugen (gleicher Schlüssel, neues Transkript).

Wenn Ihr ACP‑Client Metadaten unterstützt, können Sie dies pro Sitzung überschreiben:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Weitere Informationen zu Sitzungsschlüsseln finden Sie unter [/concepts/session](/concepts/session).

## Optionen

- `--url <url>`: Gateway‑WebSocket‑URL (Standard: gateway.remote.url, wenn konfiguriert).
- `--token <token>`: Gateway‑Authentifizierungs‑Token.
- `--password <password>`: Gateway‑Authentifizierungs‑Passwort.
- `--session <key>`: Standard‑Sitzungsschlüssel.
- `--session-label <label>`: Standard‑Sitzungslabel zur Auflösung.
- `--require-existing`: Fehlschlagen, wenn der Sitzungsschlüssel/das Label nicht existiert.
- `--reset-session`: Sitzungsschlüssel vor der ersten Verwendung zurücksetzen.
- `--no-prefix-cwd`: Prompts nicht mit dem Arbeitsverzeichnis prefixen.
- `--verbose, -v`: Ausführliche Protokollierung nach stderr.

### `acp client`‑Optionen

- `--cwd <dir>`: Arbeitsverzeichnis für die ACP‑Sitzung.
- `--server <command>`: ACP‑Server‑Befehl (Standard: `openclaw`).
- `--server-args <args...>`: Zusätzliche Argumente, die an den ACP‑Server übergeben werden.
- `--server-verbose`: Ausführliche Protokollierung auf dem ACP‑Server aktivieren.
- `--verbose, -v`: Ausführliche Client‑Protokollierung.
