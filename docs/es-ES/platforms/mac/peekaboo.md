---
summary: "Integración de PeekabooBridge para automatización de UI en macOS"
read_when:
  - Hospedando PeekabooBridge en OpenClaw.app
  - Integrando Peekaboo vía Swift Package Manager
  - Cambiando el protocolo/rutas de PeekabooBridge
title: "Peekaboo Bridge"
---

# Peekaboo Bridge (automatización de UI en macOS)

OpenClaw puede hospedar **PeekabooBridge** como un intermediario local de automatización de UI consciente de permisos. Esto permite que el CLI `peekaboo` maneje la automatización de UI mientras reutiliza los permisos TCC de la app de macOS.

## Qué es esto (y qué no es)

- **Host**: OpenClaw.app puede actuar como host de PeekabooBridge.
- **Cliente**: usa el CLI `peekaboo` (sin superficie separada `openclaw ui ...`).
- **UI**: las superposiciones visuales permanecen en Peekaboo.app; OpenClaw es un host intermediario ligero.

## Habilitar el bridge

En la app de macOS:

- Settings → **Enable Peekaboo Bridge**

Cuando está habilitado, OpenClaw inicia un servidor de socket UNIX local. Si está deshabilitado, el host se detiene y `peekaboo` recurrirá a otros hosts disponibles.

## Orden de descubrimiento del cliente

Los clientes de Peekaboo típicamente intentan hosts en este orden:

1. Peekaboo.app (UX completo)
2. Claude.app (si está instalada)
3. OpenClaw.app (intermediario ligero)

Usa `peekaboo bridge status --verbose` para ver qué host está activo y qué ruta de socket está en uso. Puedes anular con:

```bash
export PEEKABOO_BRIDGE_SOCKET=/path/to/bridge.sock
```

## Seguridad y permisos

- El bridge valida **firmas de código de llamantes**; se aplica una lista de permitidos de TeamIDs (TeamID del host de Peekaboo + TeamID de la app OpenClaw).
- Las solicitudes expiran después de ~10 segundos.
- Si faltan permisos requeridos, el bridge devuelve un mensaje de error claro en lugar de lanzar System Settings.

## Comportamiento de snapshot (automatización)

Los snapshots se almacenan en memoria y expiran automáticamente después de una ventana corta. Si necesitas retención más larga, vuelve a capturar desde el cliente.

## Solución de problemas

- Si `peekaboo` reporta "bridge client is not authorized", asegúrate de que el cliente esté correctamente firmado o ejecuta el host con `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` en modo **debug** solamente.
- Si no se encuentran hosts, abre una de las apps host (Peekaboo.app o OpenClaw.app) y confirma que los permisos estén otorgados.
