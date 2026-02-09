---
summary: "Ejecute el puente ACP para integraciones con IDE"
read_when:
  - Configuración de integraciones de IDE basadas en ACP
  - Depuración del enrutamiento de sesiones ACP hacia el Gateway
title: "acp"
---

# acp

Ejecute el puente ACP (Agent Client Protocol) que se comunica con un Gateway de OpenClaw.

Este comando habla ACP sobre stdio para IDEs y reenvía los prompts al Gateway
a través de WebSocket. Mantiene las sesiones ACP mapeadas a claves de sesión del Gateway.

## Uso

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

## Cliente ACP (depuración)

Use el cliente ACP integrado para verificar el puente sin un IDE.
Inicia el puente ACP y le permite escribir prompts de forma interactiva.

```bash
openclaw acp client

# Point the spawned bridge at a remote Gateway
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Override the server command (default: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Cómo usar esto

Use ACP cuando un IDE (u otro cliente) hable Agent Client Protocol y desee
que controle una sesión del Gateway de OpenClaw.

1. Asegúrese de que el Gateway esté en ejecución (local o remoto).
2. Configure el destino del Gateway (configuración o flags).
3. Indique a su IDE que ejecute `openclaw acp` sobre stdio.

Ejemplo de configuración (persistente):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Ejemplo de ejecución directa (sin escribir configuración):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Selección de agentes

ACP no selecciona agentes directamente. Enruta mediante la clave de sesión del Gateway.

Use claves de sesión con alcance de agente para apuntar a un agente específico:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Cada sesión ACP se asigna a una sola clave de sesión del Gateway. Un agente puede tener muchas
sesiones; ACP usa de forma predeterminada una sesión `acp:<uuid>` aislada, a menos que sobrescriba
la clave o la etiqueta.

## Configuración del editor Zed

Agregue un agente ACP personalizado en `~/.config/zed/settings.json` (o use la interfaz de configuración de Zed):

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

Para apuntar a un Gateway o agente específico:

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

En Zed, abra el panel Agent y seleccione “OpenClaw ACP” para iniciar un hilo.

## Mapeo de sesiones

De forma predeterminada, las sesiones ACP obtienen una clave de sesión del Gateway aislada con un prefijo `acp:`.
Para reutilizar una sesión conocida, pase una clave o etiqueta de sesión:

- `--session <key>`: use una clave de sesión específica del Gateway.
- `--session-label <label>`: resuelva una sesión existente por etiqueta.
- `--reset-session`: genere un nuevo id de sesión para esa clave (misma clave, nuevo transcript).

Si su cliente ACP admite metadatos, puede sobrescribir por sesión:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Obtenga más información sobre las claves de sesión en [/concepts/session](/concepts/session).

## Opciones

- `--url <url>`: URL del WebSocket del Gateway (por defecto gateway.remote.url cuando está configurado).
- `--token <token>`: token de autenticación del Gateway.
- `--password <password>`: contraseña de autenticación del Gateway.
- `--session <key>`: clave de sesión predeterminada.
- `--session-label <label>`: etiqueta de sesión predeterminada para resolver.
- `--require-existing`: fallar si la clave/etiqueta de sesión no existe.
- `--reset-session`: restablecer la clave de sesión antes del primer uso.
- `--no-prefix-cwd`: no anteponer los prompts con el directorio de trabajo.
- `--verbose, -v`: registro detallado a stderr.

### Opciones de `acp client`

- `--cwd <dir>`: directorio de trabajo para la sesión ACP.
- `--server <command>`: comando del servidor ACP (predeterminado: `openclaw`).
- `--server-args <args...>`: argumentos adicionales pasados al servidor ACP.
- `--server-verbose`: habilitar registro detallado en el servidor ACP.
- `--verbose, -v`: registro detallado del cliente.
