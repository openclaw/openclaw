---
summary: "Ingreso por webhook para activación y ejecuciones de agentes aisladas"
read_when:
  - Al agregar o cambiar endpoints de webhook
  - Al conectar sistemas externos con OpenClaw
title: "Webhooks"
---

# Webhooks

El Gateway puede exponer un pequeño endpoint HTTP de webhook para disparadores externos.

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Notas:

- `hooks.token` es obligatorio cuando `hooks.enabled=true`.
- `hooks.path` tiene como valor predeterminado `/hooks`.

## Auth

Cada solicitud debe incluir el token del hook. Prefiera encabezados:

- `Authorization: Bearer <token>` (recomendado)
- `x-openclaw-token: <token>`
- `?token=<token>` (obsoleto; registra una advertencia y se eliminará en una versión mayor futura)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **obligatorio** (string): La descripción del evento (p. ej., "Nuevo correo recibido").
- `mode` opcional (`now` | `next-heartbeat`): Si se debe activar un heartbeat inmediato (predeterminado `now`) o esperar la siguiente verificación periódica.

Efecto:

- Encola un evento del sistema para la sesión **principal**
- Si `mode=now`, activa un heartbeat inmediato

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **obligatorio** (string): El prompt o mensaje que el agente debe procesar.
- `name` opcional (string): Nombre legible para humanos del hook (p. ej., "GitHub"), usado como prefijo en los resúmenes de sesión.
- `sessionKey` opcional (string): La clave usada para identificar la sesión del agente. Por defecto es un `hook:<uuid>` aleatorio. Usar una clave consistente permite una conversación de varios turnos dentro del contexto del hook.
- `wakeMode` opcional (`now` | `next-heartbeat`): Si se debe activar un heartbeat inmediato (predeterminado `now`) o esperar la siguiente verificación periódica.
- `deliver` opcional (boolean): Si `true`, la respuesta del agente se enviará al canal de mensajería. El valor predeterminado es `true`. Las respuestas que solo son acuses de heartbeat se omiten automáticamente.
- `channel` opcional (string): El canal de mensajería para la entrega. Uno de: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. El valor predeterminado es `last`.
- `to` opcional (string): El identificador del destinatario para el canal (p. ej., número de teléfono para WhatsApp/Signal, ID de chat para Telegram, ID de canal para Discord/Slack/Mattermost (plugin), ID de conversación para MS Teams). Por defecto, el último destinatario en la sesión principal.
- `model` opcional (string): Anulación del modelo (p. ej., `anthropic/claude-3-5-sonnet` o un alias). Debe estar en la lista de modelos permitidos si hay restricciones.
- `thinking` opcional (string): Anulación del nivel de razonamiento (p. ej., `low`, `medium`, `high`).
- `timeoutSeconds` opcional (number): Duración máxima de la ejecución del agente en segundos.

Efecto:

- Ejecuta un turno de agente **aislado** (clave de sesión propia)
- Siempre publica un resumen en la sesión **principal**
- Si `wakeMode=now`, activa un heartbeat inmediato

### `POST /hooks/<name>` (mapped)

Los nombres de hooks personalizados se resuelven mediante `hooks.mappings` (consulte la configuración). Un mapeo puede
convertir payloads arbitrarios en acciones `wake` o `agent`, con plantillas opcionales o
transformaciones de código.

Opciones de mapeo (resumen):

- `hooks.presets: ["gmail"]` habilita el mapeo integrado de Gmail.
- `hooks.mappings` le permite definir `match`, `action` y plantillas en la configuración.
- `hooks.transformsDir` + `transform.module` carga un módulo JS/TS para lógica personalizada.
- Use `match.source` para mantener un endpoint de ingesta genérico (enrutamiento impulsado por el payload).
- Las transformaciones TS requieren un cargador TS (p. ej., `bun` o `tsx`) o `.js` precompilado en tiempo de ejecución.
- Configure `deliver: true` + `channel`/`to` en los mapeos para enrutar respuestas a una superficie de chat
  (`channel` tiene como valor predeterminado `last` y recurre a WhatsApp).
- `allowUnsafeExternalContent: true` deshabilita el envoltorio externo de seguridad de contenido para ese hook
  (peligroso; solo para fuentes internas de confianza).
- `openclaw webhooks gmail setup` escribe la configuración `hooks.gmail` para `openclaw webhooks gmail run`.
  Consulte [Gmail Pub/Sub](/automation/gmail-pubsub) para el flujo completo de vigilancia de Gmail.

## Responses

- `200` para `/hooks/wake`
- `202` para `/hooks/agent` (ejecución asíncrona iniciada)
- `401` en falla de autenticación
- `400` en payload inválido
- `413` en payloads de tamaño excesivo

## Examples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Use a different model

Agregue `model` al payload del agente (o al mapeo) para anular el modelo en esa ejecución:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Si aplica `agents.defaults.models`, asegúrese de que el modelo de anulación esté incluido allí.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- Mantenga los endpoints de hook detrás de loopback, tailnet o un proxy inverso de confianza.
- Use un token de hook dedicado; no reutilice tokens de autenticación del gateway.
- Evite incluir payloads sin procesar sensibles en los registros de webhooks.
- Los payloads de hook se tratan como no confiables y, por defecto, se envuelven con límites de seguridad.
  Si debe deshabilitar esto para un hook específico, configure `allowUnsafeExternalContent: true`
  en el mapeo de ese hook (peligroso).
