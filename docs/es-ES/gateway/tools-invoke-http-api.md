---
summary: "Invocar una sola herramienta directamente mediante el endpoint HTTP del Gateway"
read_when:
  - Llamar herramientas sin ejecutar un turno completo del agente
  - Construir automatizaciones que necesitan aplicación de políticas de herramientas
title: "API de invocación de herramientas"
---

# Invocación de herramientas (HTTP)

El Gateway de OpenClaw expone un endpoint HTTP simple para invocar una sola herramienta directamente. Está siempre habilitado, pero protegido por autenticación del Gateway y política de herramientas.

- `POST /tools/invoke`
- Mismo puerto que el Gateway (multiplexado WS + HTTP): `http://<gateway-host>:<port>/tools/invoke`

El tamaño máximo de payload por defecto es 2 MB.

## Autenticación

Usa la configuración de autenticación del Gateway. Envía un token bearer:

- `Authorization: Bearer <token>`

Notas:

- Cuando `gateway.auth.mode="token"`, usa `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Cuando `gateway.auth.mode="password"`, usa `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).
- Si `gateway.auth.rateLimit` está configurado y ocurren demasiados fallos de autenticación, el endpoint devuelve `429` con `Retry-After`.

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
- `action` (string, opcional): mapeado en args si el esquema de la herramienta admite `action` y el payload de args lo omitió.
- `args` (object, opcional): argumentos específicos de la herramienta.
- `sessionKey` (string, opcional): clave de sesión objetivo. Si se omite o es `"main"`, el Gateway usa la clave de sesión principal configurada (respeta `session.mainKey` y el agente por defecto, o `global` en alcance global).
- `dryRun` (boolean, opcional): reservado para uso futuro; actualmente ignorado.

## Comportamiento de política + enrutamiento

La disponibilidad de herramientas se filtra a través de la misma cadena de políticas usada por los agentes del Gateway:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- políticas de grupo (si la clave de sesión se mapea a un grupo o canal)
- política de subagente (al invocar con una clave de sesión de subagente)

Si una herramienta no está permitida por política, el endpoint devuelve **404**.

El HTTP del Gateway también aplica una lista de denegación estricta por defecto (incluso si la política de sesión permite la herramienta):

- `sessions_spawn`
- `sessions_send`
- `gateway`
- `whatsapp_login`

Puedes personalizar esta lista de denegación mediante `gateway.tools`:

```json5
{
  gateway: {
    tools: {
      // Herramientas adicionales a bloquear sobre HTTP /tools/invoke
      deny: ["browser"],
      // Remover herramientas de la lista de denegación por defecto
      allow: ["gateway"],
    },
  },
}
```

Para ayudar a las políticas de grupo a resolver contexto, puedes configurar opcionalmente:

- `x-openclaw-message-channel: <channel>` (ejemplo: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (cuando existen múltiples cuentas)

## Respuestas

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (solicitud inválida o error de entrada de herramienta)
- `401` → no autorizado
- `429` → autenticación limitada por tasa (`Retry-After` configurado)
- `404` → herramienta no disponible (no encontrada o no en lista de permitidos)
- `405` → método no permitido
- `500` → `{ ok: false, error: { type, message } }` (error inesperado de ejecución de herramienta; mensaje sanitizado)

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
