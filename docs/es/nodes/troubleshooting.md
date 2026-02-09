---
summary: "Solucione problemas de emparejamiento de nodos, requisitos de primer plano, permisos y fallos de herramientas"
read_when:
  - El nodo está conectado, pero fallan las herramientas de cámara/lienzo/pantalla/exec
  - Necesita el modelo mental de emparejamiento del nodo frente a aprobaciones
title: "Solución de problemas de nodos"
---

# Solución de problemas de nodos

Use esta página cuando un nodo esté visible en el estado, pero las herramientas del nodo fallen.

## Escalera de comandos

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego ejecute comprobaciones específicas del nodo:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Señales saludables:

- El nodo está conectado y emparejado para el rol `node`.
- `nodes describe` incluye la capacidad que usted está invocando.
- Las aprobaciones de exec muestran el modo/lista de permitidos esperados.

## Requisitos de primer plano

`canvas.*`, `camera.*` y `screen.*` son solo de primer plano en nodos iOS/Android.

Comprobación y solución rápidas:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Si ve `NODE_BACKGROUND_UNAVAILABLE`, lleve la app del nodo al primer plano y vuelva a intentarlo.

## Matriz de permisos

| Capacidad                    | iOS                                                             | Android                                                                | app de nodo macOS                                           | Código de fallo típico         |
| ---------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Cámara (+ micrófono para audio del clip)     | Cámara (+ micrófono para audio del clip)            | Cámara (+ micrófono para audio del clip) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Grabación de pantalla (+ micrófono opcional) | Aviso de captura de pantalla (+ micrófono opcional) | Grabación de pantalla                                       | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Mientras se usa o Siempre (depende del modo) | Ubicación en primer plano/segundo plano según el modo                  | Permiso de ubicación                                        | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (ruta del host del nodo)                 | n/a (ruta del host del nodo)                        | Se requieren aprobaciones de exec                           | `SYSTEM_RUN_DENIED`            |

## Emparejamiento versus aprobaciones

Estas son puertas diferentes:

1. **Emparejamiento del dispositivo**: ¿puede este nodo conectarse al Gateway?
2. **Aprobaciones de exec**: ¿puede este nodo ejecutar un comando de shell específico?

Comprobaciones rápidas:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Si falta el emparejamiento, apruebe primero el dispositivo del nodo.
Si el emparejamiento está bien pero falla `system.run`, corrija las aprobaciones/lista de permitidos de exec.

## Códigos de error comunes del nodo

- `NODE_BACKGROUND_UNAVAILABLE` → la app está en segundo plano; llévela al primer plano.
- `CAMERA_DISABLED` → el interruptor de cámara está deshabilitado en la configuración del nodo.
- `*_PERMISSION_REQUIRED` → permiso del SO ausente/denegado.
- `LOCATION_DISABLED` → el modo de ubicación está desactivado.
- `LOCATION_PERMISSION_REQUIRED` → el modo de ubicación solicitado no está concedido.
- `LOCATION_BACKGROUND_UNAVAILABLE` → la app está en segundo plano, pero solo existe el permiso Mientras se usa.
- `SYSTEM_RUN_DENIED: approval required` → la solicitud de exec necesita aprobación explícita.
- `SYSTEM_RUN_DENIED: allowlist miss` → el comando está bloqueado por el modo de lista de permitidos.

## Bucle de recuperación rápida

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Si aún está atascado:

- Vuelva a aprobar el emparejamiento del dispositivo.
- Reabra la app del nodo (primer plano).
- Vuelva a conceder los permisos del SO.
- Recree/ajuste la política de aprobaciones de exec.

Relacionado:

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)
