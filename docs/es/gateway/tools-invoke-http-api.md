---
summary: "Invocar una sola herramienta directamente a través del endpoint HTTP del Gateway"
read_when:
  - Llamar herramientas sin ejecutar un turno completo del agente
  - Crear automatizaciones que necesiten la aplicación de políticas de herramientas
title: "API de Invocación de Herramientas"
---

# Invocación de Herramientas (HTTP)

El Gateway de OpenClaw expone un endpoint HTTP sencillo para invocar una sola herramienta directamente. Siempre está habilitado, pero está protegido por la autenticación del Gateway y la política de herramientas.

- `POST /tools/invoke`
- Mismo puerto que el Gateway (multiplexación WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

El tamaño máximo de carga útil predeterminado es de 2 MB.

## Autenticación

Usa la configuración de autenticación del Gateway. Envíe un token bearer:

- `Authorization: Bearer <token>`

Notas:

- Cuando `gateway.auth.mode="token"`, use `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Cuando `gateway.auth.mode="password"`, use `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).

## Cuerpo de la solicitud

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Campos:

- `tool` (string, requerido): nombre de la herramienta a invocar.
- `action` (string, opcional): se asigna a args si el esquema de la herramienta admite `action` y la carga útil de args lo omitió.
- `args` (object, opcional): argumentos específicos de la herramienta.
- `sessionKey` (string, opcional): clave de sesión de destino. Si se omite o es `"main"`, el Gateway usa la clave de sesión principal configurada (respeta `session.mainKey` y el agente predeterminado, o `global` en el ámbito global).
- `dryRun` (boolean, opcional): reservado para uso futuro; actualmente se ignora.

## Política + comportamiento de enrutamiento

La disponibilidad de herramientas se filtra mediante la misma cadena de políticas utilizada por los agentes del Gateway:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- políticas de grupo (si la clave de sesión se asigna a un grupo o canal)
- política de subagente (al invocar con una clave de sesión de subagente)

Si una herramienta no está permitida por la política, el endpoint devuelve **404**.

Para ayudar a que las políticas de grupo resuelvan el contexto, puede establecer opcionalmente:

- `x-openclaw-message-channel: <channel>` (ejemplo: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (cuando existen múltiples cuentas)

## Respuestas

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (solicitud inválida o error de la herramienta)
- `401` → no autorizado
- `404` → herramienta no disponible (no encontrada o no en la lista de permitidos)
- `405` → método no permitido

## Ejemplo

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
