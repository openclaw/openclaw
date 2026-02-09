---
summary: "Referencia de la CLI para `openclaw node` (host de nodo sin interfaz)"
read_when:
  - Ejecución del host de nodo sin interfaz
  - Emparejamiento de un nodo que no sea macOS para system.run
title: "node"
---

# `openclaw node`

Ejecute un **host de nodo sin interfaz** que se conecta al WebSocket del Gateway y expone
`system.run` / `system.which` en esta máquina.

## ¿Por qué usar un host de nodo?

Use un host de nodo cuando quiera que los agentes **ejecuten comandos en otras máquinas** de su
red sin instalar allí una aplicación complementaria completa de macOS.

Casos de uso comunes:

- Ejecutar comandos en cajas Linux/Windows remotas (servidores de compilación, máquinas de laboratorio, NAS).
- Mantener la ejecución **en sandbox** en el Gateway, pero delegar ejecuciones aprobadas a otros hosts.
- Proporcionar un destino de ejecución ligero y sin interfaz para automatización o nodos de CI.

La ejecución sigue estando protegida por **aprobaciones de exec** y listas de permitidos por agente en el
host de nodo, para que pueda mantener el acceso a comandos limitado y explícito.

## Proxy del navegador (configuración cero)

Los hosts de nodo anuncian automáticamente un proxy del navegador si `browser.enabled` no está
deshabilitado en el nodo. Esto permite que el agente use automatización del navegador en ese nodo
sin configuración adicional.

Desactívelo en el nodo si es necesario:

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Ejecutar (primer plano)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Opciones:

- `--host <host>`: Host del WebSocket del Gateway (predeterminado: `127.0.0.1`)
- `--port <port>`: Puerto del WebSocket del Gateway (predeterminado: `18789`)
- `--tls`: Usar TLS para la conexión con el Gateway
- `--tls-fingerprint <sha256>`: Huella digital esperada del certificado TLS (sha256)
- `--node-id <id>`: Anular el id del nodo (borra el token de emparejamiento)
- `--display-name <name>`: Anular el nombre visible del nodo

## Servicio (segundo plano)

Instale un host de nodo sin interfaz como servicio de usuario.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Opciones:

- `--host <host>`: Host del WebSocket del Gateway (predeterminado: `127.0.0.1`)
- `--port <port>`: Puerto del WebSocket del Gateway (predeterminado: `18789`)
- `--tls`: Usar TLS para la conexión con el Gateway
- `--tls-fingerprint <sha256>`: Huella digital esperada del certificado TLS (sha256)
- `--node-id <id>`: Anular el id del nodo (borra el token de emparejamiento)
- `--display-name <name>`: Anular el nombre visible del nodo
- `--runtime <runtime>`: Entorno de ejecución del servicio (`node` o `bun`)
- `--force`: Reinstalar/sobrescribir si ya está instalado

Administrar el servicio:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Use `openclaw node run` para un host de nodo en primer plano (sin servicio).

Los comandos del servicio aceptan `--json` para salida legible por máquina.

## Emparejamiento

La primera conexión crea una solicitud de emparejamiento de nodo pendiente en el Gateway.
Apruébela mediante:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

El host de nodo almacena su id de nodo, token, nombre visible y la información de conexión con el
Gateway en `~/.openclaw/node.json`.

## Aprobaciones de exec

`system.run` está restringido por aprobaciones locales de exec:

- `~/.openclaw/exec-approvals.json`
- [Aprobaciones de exec](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (editar desde el Gateway)
