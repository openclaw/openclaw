---
summary: "Referencia de la CLI para `openclaw devices` (emparejamiento de dispositivos + rotación/revocación de tokens)"
read_when:
  - Está aprobando solicitudes de emparejamiento de dispositivos
  - Necesita rotar o revocar tokens de dispositivos
title: "dispositivos"
---

# `openclaw devices`

Administre las solicitudes de emparejamiento de dispositivos y los tokens con alcance por dispositivo.

## Comandos

### `openclaw devices list`

Enumere las solicitudes de emparejamiento pendientes y los dispositivos emparejados.

```
openclaw devices list
openclaw devices list --json
```

### `openclaw devices approve <requestId>`

Apruebe una solicitud de emparejamiento de dispositivo pendiente.

```
openclaw devices approve <requestId>
```

### `openclaw devices reject <requestId>`

Rechace una solicitud de emparejamiento de dispositivo pendiente.

```
openclaw devices reject <requestId>
```

### `openclaw devices rotate --device <id> --role <role> [--scope <scope...>]`

Rote un token de dispositivo para un rol específico (opcionalmente actualizando los alcances).

```
openclaw devices rotate --device <deviceId> --role operator --scope operator.read --scope operator.write
```

### `openclaw devices revoke --device <id> --role <role>`

Revoque un token de dispositivo para un rol específico.

```
openclaw devices revoke --device <deviceId> --role node
```

## Opciones comunes

- `--url <url>`: URL de WebSocket del Gateway (por defecto `gateway.remote.url` cuando está configurado).
- `--token <token>`: Token del Gateway (si es requerido).
- `--password <password>`: Contraseña del Gateway (autenticación por contraseña).
- `--timeout <ms>`: Tiempo de espera del RPC.
- `--json`: Salida JSON (recomendada para scripting).

Nota: cuando establece `--url`, la CLI no recurre a credenciales de configuración ni de variables de entorno.
Pase `--token` o `--password` explícitamente. La falta de credenciales explícitas es un error.

## Notas

- La rotación de tokens devuelve un token nuevo (sensible). Trátelo como un secreto.
- Estos comandos requieren el alcance `operator.pairing` (o `operator.admin`).
