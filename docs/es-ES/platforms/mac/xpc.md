---
summary: "Arquitectura IPC de macOS para la app de OpenClaw, transporte de nodo del gateway y PeekabooBridge"
read_when:
  - Editando contratos IPC o IPC de la app de barra de menú
title: "IPC de macOS"
---

# Arquitectura IPC de macOS de OpenClaw

**Modelo actual:** un socket Unix local conecta el **servicio de host de nodo** a la **app de macOS** para aprobaciones de exec + `system.run`. Existe un CLI de depuración `openclaw-mac` para verificaciones de descubrimiento/conexión; las acciones de agente todavía fluyen a través del WebSocket del Gateway y `node.invoke`. La automatización de UI usa PeekabooBridge.

## Objetivos

- Instancia única de app GUI que posee todo el trabajo orientado a TCC (notificaciones, grabación de pantalla, micrófono, habla, AppleScript).
- Una superficie pequeña para automatización: comandos de Gateway + nodo, más PeekabooBridge para automatización de UI.
- Permisos predecibles: siempre el mismo ID de bundle firmado, lanzado por launchd, para que los otorgamientos TCC se mantengan.

## Cómo funciona

### Gateway + transporte de nodo

- La app ejecuta el Gateway (modo local) y se conecta a él como un nodo.
- Las acciones de agente se realizan vía `node.invoke` (ej. `system.run`, `system.notify`, `canvas.*`).

### Servicio de nodo + IPC de app

- Un servicio de host de nodo sin interfaz se conecta al WebSocket del Gateway.
- Las solicitudes de `system.run` se reenvían a la app de macOS sobre un socket Unix local.
- La app realiza el exec en contexto de UI, solicita si es necesario, y devuelve salida.

Diagrama (SCI):

```
Agente -> Gateway -> Servicio de Nodo (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  App de Mac (UI + TCC + system.run)
```

### PeekabooBridge (automatización de UI)

- La automatización de UI usa un socket UNIX separado llamado `bridge.sock` y el protocolo JSON de PeekabooBridge.
- Orden de preferencia de host (lado cliente): Peekaboo.app → Claude.app → OpenClaw.app → ejecución local.
- Seguridad: los hosts de bridge requieren un TeamID permitido; la salida de escape DEBUG-only same-UID está protegida por `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (convención de Peekaboo).
- Ve: [uso de PeekabooBridge](/es-ES/platforms/mac/peekaboo) para detalles.

## Flujos operacionales

- Reiniciar/recompilar: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Mata instancias existentes
  - Construcción Swift + empaquetado
  - Escribe/bootstraps/kickstarts el LaunchAgent
- Instancia única: la app sale temprano si otra instancia con el mismo ID de bundle está ejecutándose.

## Notas de endurecimiento

- Prefiere requerir una coincidencia de TeamID para todas las superficies privilegiadas.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (DEBUG-only) puede permitir llamantes same-UID para desarrollo local.
- Toda la comunicación permanece solo local; no se exponen sockets de red.
- Los prompts TCC se originan solo desde el bundle de la app GUI; mantén el ID de bundle firmado estable entre recompilaciones.
- Endurecimiento IPC: modo de socket `0600`, token, verificaciones de peer-UID, desafío/respuesta HMAC, TTL corto.
