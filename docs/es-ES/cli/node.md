---
summary: "Referencia CLI para `openclaw node` (host de nodo sin interfaz gráfica)"
read_when:
  - Ejecutando el host de nodo sin interfaz gráfica
  - Emparejando un nodo no-macOS para system.run
title: "node"
---

# `openclaw node`

Ejecuta un **host de nodo sin interfaz gráfica** que se conecta al WebSocket del Gateway y expone
`system.run` / `system.which` en esta máquina.

## ¿Por qué usar un host de nodo?

Usa un host de nodo cuando quieras que los agentes **ejecuten comandos en otras máquinas** en tu
red sin instalar una aplicación complementaria completa de macOS allí.

Casos de uso comunes:

- Ejecutar comandos en máquinas remotas Linux/Windows (servidores de construcción, máquinas de laboratorio, NAS).
- Mantener exec **en sandbox** en el gateway, pero delegar ejecuciones aprobadas a otros hosts.
- Proporcionar un objetivo de ejecución ligero y sin interfaz gráfica para nodos de automatización o CI.

La ejecución sigue protegida por **aprobaciones exec** y listas de permisos por agente en el
host del nodo, para que puedas mantener el acceso a comandos delimitado y explícito.

## Proxy de navegador (configuración cero)

Los hosts de nodo anuncian automáticamente un proxy de navegador si `browser.enabled` no está
deshabilitado en el nodo. Esto permite que el agente use automatización de navegador en ese nodo
sin configuración adicional.

Deshabilítalo en el nodo si es necesario:

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

- `--host <host>`: Host WebSocket del Gateway (predeterminado: `127.0.0.1`)
- `--port <port>`: Puerto WebSocket del Gateway (predeterminado: `18789`)
- `--tls`: Usar TLS para la conexión del gateway
- `--tls-fingerprint <sha256>`: Huella digital del certificado TLS esperado (sha256)
- `--node-id <id>`: Sobrescribir id del nodo (limpia el token de emparejamiento)
- `--display-name <name>`: Sobrescribir el nombre de visualización del nodo

## Servicio (segundo plano)

Instala un host de nodo sin interfaz gráfica como servicio de usuario.

```bash
openclaw node install --host <gateway-host> --port 18789
```

Opciones:

- `--host <host>`: Host WebSocket del Gateway (predeterminado: `127.0.0.1`)
- `--port <port>`: Puerto WebSocket del Gateway (predeterminado: `18789`)
- `--tls`: Usar TLS para la conexión del gateway
- `--tls-fingerprint <sha256>`: Huella digital del certificado TLS esperado (sha256)
- `--node-id <id>`: Sobrescribir id del nodo (limpia el token de emparejamiento)
- `--display-name <name>`: Sobrescribir el nombre de visualización del nodo
- `--runtime <runtime>`: Runtime del servicio (`node` o `bun`)
- `--force`: Reinstalar/sobrescribir si ya está instalado

Gestiona el servicio:

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

Usa `openclaw node run` para un host de nodo en primer plano (sin servicio).

Los comandos de servicio aceptan `--json` para salida legible por máquina.

## Emparejamiento

La primera conexión crea una solicitud de emparejamiento de nodo pendiente en el Gateway.
Apruébala mediante:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

El host del nodo almacena su id de nodo, token, nombre de visualización e información de conexión del gateway en
`~/.openclaw/node.json`.

## Aprobaciones exec

`system.run` está protegido por aprobaciones exec locales:

- `~/.openclaw/exec-approvals.json`
- [Aprobaciones exec](/es-ES/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (editar desde el Gateway)
