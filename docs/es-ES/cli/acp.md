---
summary: "Ejecutar el puente ACP para integraciones con IDEs"
read_when:
  - Configurando integraciones con IDEs basadas en ACP
  - Depurando el enrutamiento de sesiones ACP al Gateway
title: "acp"
---

# acp

Ejecuta el puente ACP (Protocolo de Cliente de Agente) que se comunica con un Gateway de OpenClaw.

Este comando habla ACP por stdio para IDEs y reenvía prompts al Gateway
por WebSocket. Mantiene las sesiones ACP mapeadas a claves de sesión del Gateway.

## Uso

```bash
openclaw acp

# Gateway remoto
openclaw acp --url wss://gateway-host:18789 --token <token>

# Adjuntar a una clave de sesión existente
openclaw acp --session agent:main:main

# Adjuntar por etiqueta (debe existir previamente)
openclaw acp --session-label "support inbox"

# Restablecer la clave de sesión antes del primer prompt
openclaw acp --session agent:main:main --reset-session
```

## Cliente ACP (depuración)

Usa el cliente ACP integrado para verificar el puente sin un IDE.
Genera el puente ACP y te permite escribir prompts de forma interactiva.

```bash
openclaw acp client

# Apuntar el puente generado a un Gateway remoto
openclaw acp client --server-args --url wss://gateway-host:18789 --token <token>

# Sobrescribir el comando del servidor (predeterminado: openclaw)
openclaw acp client --server "node" --server-args openclaw.mjs acp --url ws://127.0.0.1:19001
```

## Cómo usar esto

Usa ACP cuando un IDE (u otro cliente) hable Protocolo de Cliente de Agente y quieras
que conduzca una sesión del Gateway de OpenClaw.

1. Asegúrate de que el Gateway esté en ejecución (local o remoto).
2. Configura el destino del Gateway (config o flags).
3. Apunta tu IDE a ejecutar `openclaw acp` por stdio.

Ejemplo de configuración (persistente):

```bash
openclaw config set gateway.remote.url wss://gateway-host:18789
openclaw config set gateway.remote.token <token>
```

Ejemplo de ejecución directa (sin escribir config):

```bash
openclaw acp --url wss://gateway-host:18789 --token <token>
```

## Seleccionando agentes

ACP no selecciona agentes directamente. Enruta por la clave de sesión del Gateway.

Usa claves de sesión con alcance de agente para apuntar a un agente específico:

```bash
openclaw acp --session agent:main:main
openclaw acp --session agent:design:main
openclaw acp --session agent:qa:bug-123
```

Cada sesión ACP se mapea a una única clave de sesión del Gateway. Un agente puede tener muchas
sesiones; ACP predetermina a una sesión aislada `acp:<uuid>` a menos que sobrescribas
la clave o etiqueta.

## Configuración del editor Zed

Añade un agente ACP personalizado en `~/.config/zed/settings.json` (o usa la interfaz de Configuración de Zed):

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

En Zed, abre el panel de Agente y selecciona "OpenClaw ACP" para iniciar un hilo.

## Mapeo de sesiones

Por defecto, las sesiones ACP obtienen una clave de sesión del Gateway aislada con un prefijo `acp:`.
Para reutilizar una sesión conocida, pasa una clave o etiqueta de sesión:

- `--session <key>`: usa una clave de sesión del Gateway específica.
- `--session-label <label>`: resuelve una sesión existente por etiqueta.
- `--reset-session`: crea un id de sesión nuevo para esa clave (misma clave, nueva transcripción).

Si tu cliente ACP admite metadatos, puedes sobrescribir por sesión:

```json
{
  "_meta": {
    "sessionKey": "agent:main:main",
    "sessionLabel": "support inbox",
    "resetSession": true
  }
}
```

Aprende más sobre claves de sesión en [/es-ES/concepts/session](/es-ES/concepts/session).

## Opciones

- `--url <url>`: URL WebSocket del Gateway (predeterminado a gateway.remote.url cuando está configurado).
- `--token <token>`: Token de autenticación del Gateway.
- `--password <password>`: Contraseña de autenticación del Gateway.
- `--session <key>`: clave de sesión predeterminada.
- `--session-label <label>`: etiqueta de sesión predeterminada a resolver.
- `--require-existing`: falla si la clave/etiqueta de sesión no existe.
- `--reset-session`: restablece la clave de sesión antes del primer uso.
- `--no-prefix-cwd`: no prefija los prompts con el directorio de trabajo.
- `--verbose, -v`: registro detallado a stderr.

### Opciones de `acp client`

- `--cwd <dir>`: directorio de trabajo para la sesión ACP.
- `--server <command>`: comando del servidor ACP (predeterminado: `openclaw`).
- `--server-args <args...>`: argumentos adicionales pasados al servidor ACP.
- `--server-verbose`: habilita el registro detallado en el servidor ACP.
- `--verbose, -v`: registro detallado del cliente.
