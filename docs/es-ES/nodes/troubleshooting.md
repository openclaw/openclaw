---
summary: "Solucionar emparejamiento de nodos, requisitos de primer plano, permisos y fallas de herramientas"
read_when:
  - El nodo está conectado pero las herramientas camera/canvas/screen/exec fallan
  - Necesitas el modelo mental de emparejamiento de nodos vs aprobaciones
title: "Solución de problemas de Nodos"
---

# Solución de problemas de nodos

Usa esta página cuando un nodo esté visible en estado pero las herramientas del nodo fallen.

## Escalera de comandos

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego ejecuta verificaciones específicas del nodo:

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

Señales saludables:

- El nodo está conectado y emparejado para el rol `node`.
- `nodes describe` incluye la capacidad que estás llamando.
- Las aprobaciones exec muestran el modo/lista permitida esperados.

## Requisitos de primer plano

`canvas.*`, `camera.*` y `screen.*` solo están disponibles en primer plano en nodos iOS/Android.

Verificación y corrección rápida:

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

Si ves `NODE_BACKGROUND_UNAVAILABLE`, trae la aplicación del nodo al primer plano y vuelve a intentarlo.

## Matriz de permisos

| Capacidad                    | iOS                                     | Android                                      | Aplicación nodo macOS         | Código de fallo típico         |
| ---------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------ |
| `camera.snap`, `camera.clip` | Cámara (+ micrófono para audio de clip) | Cámara (+ micrófono para audio de clip)      | Cámara (+ micrófono para audio de clip) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Grabación de pantalla (+ micrófono opcional) | Aviso de captura de pantalla (+ micrófono opcional) | Grabación de pantalla         | `*_PERMISSION_REQUIRED`        |
| `location.get`               | Mientras se usa o Siempre (depende del modo) | Ubicación en primer plano/segundo plano según modo | Permiso de ubicación          | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (ruta de host de nodo)              | n/a (ruta de host de nodo)                   | Aprobaciones exec requeridas  | `SYSTEM_RUN_DENIED`            |

## Emparejamiento versus aprobaciones

Estas son puertas diferentes:

1. **Emparejamiento de dispositivos**: ¿puede este nodo conectarse al gateway?
2. **Aprobaciones exec**: ¿puede este nodo ejecutar un comando de shell específico?

Verificaciones rápidas:

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

Si falta el emparejamiento, aprueba primero el dispositivo del nodo.
Si el emparejamiento está bien pero `system.run` falla, corrige las aprobaciones exec/lista permitida.

## Códigos de error comunes de nodos

- `NODE_BACKGROUND_UNAVAILABLE` → la aplicación está en segundo plano; tráela al primer plano.
- `CAMERA_DISABLED` → el interruptor de cámara está deshabilitado en la configuración del nodo.
- `*_PERMISSION_REQUIRED` → falta permiso del sistema operativo o fue denegado.
- `LOCATION_DISABLED` → el modo de ubicación está desactivado.
- `LOCATION_PERMISSION_REQUIRED` → el modo de ubicación solicitado no fue otorgado.
- `LOCATION_BACKGROUND_UNAVAILABLE` → la aplicación está en segundo plano pero solo existe el permiso Mientras se usa.
- `SYSTEM_RUN_DENIED: approval required` → la solicitud exec necesita aprobación explícita.
- `SYSTEM_RUN_DENIED: allowlist miss` → comando bloqueado por modo de lista permitida.

## Bucle de recuperación rápida

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

Si aún estás atascado:

- Vuelve a aprobar el emparejamiento del dispositivo.
- Vuelve a abrir la aplicación del nodo (primer plano).
- Vuelve a otorgar los permisos del sistema operativo.
- Recrea/ajusta la política de aprobación exec.

Relacionado:

- [/es-ES/nodes/index](/es-ES/nodes/index)
- [/es-ES/nodes/camera](/es-ES/nodes/camera)
- [/es-ES/nodes/location-command](/es-ES/nodes/location-command)
- [/es-ES/tools/exec-approvals](/es-ES/tools/exec-approvals)
- [/es-ES/gateway/pairing](/es-ES/gateway/pairing)
