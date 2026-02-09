---
summary: "Arquitectura de IPC de macOS para la app OpenClaw, el transporte del nodo del Gateway y PeekabooBridge"
read_when:
  - Al editar contratos de IPC o el IPC de la app de la barra de menús
title: "IPC de macOS"
---

# Arquitectura de IPC de OpenClaw en macOS

**Modelo actual:** un socket Unix local conecta el **servicio host del nodo** con la **app de macOS** para aprobaciones de exec + `system.run`. Existe una CLI de depuración `openclaw-mac` para comprobaciones de descubrimiento/conexión; las acciones del agente siguen fluyendo a través del WebSocket del Gateway y `node.invoke`. La automatización de la UI utiliza PeekabooBridge.

## Objetivos

- Una única instancia de app GUI que posea todo el trabajo orientado a TCC (notificaciones, grabación de pantalla, micrófono, voz, AppleScript).
- Una superficie pequeña para la automatización: Gateway + comandos del nodo, además de PeekabooBridge para la automatización de la UI.
- Permisos predecibles: siempre el mismo ID de bundle firmado, iniciado por launchd, para que las concesiones de TCC persistan.

## Cómo funciona

### Gateway + transporte del nodo

- La app ejecuta el Gateway (modo local) y se conecta a él como un nodo.
- Las acciones del agente se realizan mediante `node.invoke` (p. ej., `system.run`, `system.notify`, `canvas.*`).

### Servicio del nodo + IPC de la app

- Un servicio host del nodo sin interfaz se conecta al WebSocket del Gateway.
- Las solicitudes `system.run` se reenvían a la app de macOS a través de un socket Unix local.
- La app realiza el exec en el contexto de la UI, solicita confirmación si es necesario y devuelve la salida.

Diagrama (SCI):

```
Agent -> Gateway -> Node Service (WS)
                      |  IPC (UDS + token + HMAC + TTL)
                      v
                  Mac App (UI + TCC + system.run)
```

### PeekabooBridge (automatización de la UI)

- La automatización de la UI utiliza un socket UNIX separado llamado `bridge.sock` y el protocolo JSON de PeekabooBridge.
- Orden de preferencia de host (lado del cliente): Peekaboo.app → Claude.app → OpenClaw.app → ejecución local.
- Seguridad: los hosts del bridge requieren un TeamID permitido; la vía de escape DEBUG-only con mismo UID está protegida por `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (convención de Peekaboo).
- Ver: [Uso de PeekabooBridge](/platforms/mac/peekaboo) para más detalles.

## Flujos operativos

- Reinicio/reconstrucción: `SIGN_IDENTITY="Apple Development: <Developer Name> (<TEAMID>)" scripts/restart-mac.sh`
  - Mata las instancias existentes
  - Compilación Swift + empaquetado
  - Escribe/arranca/kickstart del LaunchAgent
- Instancia única: la app sale de forma anticipada si se está ejecutando otra instancia con el mismo ID de bundle.

## Notas de endurecimiento

- Prefiera exigir una coincidencia de TeamID para todas las superficies privilegiadas.
- PeekabooBridge: `PEEKABOO_ALLOW_UNSIGNED_SOCKET_CLIENTS=1` (solo DEBUG) puede permitir llamadores con el mismo UID para desarrollo local.
- Toda la comunicación permanece solo local; no se exponen sockets de red.
- Los avisos de TCC se originan únicamente desde el bundle de la app GUI; mantenga estable el ID de bundle firmado entre reconstrucciones.
- Endurecimiento de IPC: modo de socket `0600`, token, comprobaciones de UID del par, desafío/respuesta HMAC, TTL corto.
