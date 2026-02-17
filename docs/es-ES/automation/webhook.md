---
title: Webhooks
description: Recibe notificaciones instantáneas mediante webhooks HTTP de tu Gateway OpenClaw
---

Los webhooks te permiten recibir notificaciones push en tiempo real desde tu Gateway OpenClaw hacia tu servidor o servicio HTTP. En lugar de que tu código consulte periódicamente el estado, el Gateway envía solicitudes HTTP POST a tu endpoint configurado cuando ocurren eventos específicos.

## Descripción general

Los webhooks de OpenClaw funcionan como sigue:

1. Configuras una URL de webhook y un secreto opcional en la configuración de tu Gateway
2. El Gateway monitorea eventos (mensajes, cambios de estado de canal, errores, etc.)
3. Cuando ocurre un evento coincidente, el Gateway envía una solicitud HTTP POST a tu URL
4. Tu servidor recibe y procesa el payload del webhook

<Note>
Los webhooks están disponibles en la versión 2025.1.18 de OpenClaw y posteriores.
</Note>

## Configuración

### Configuración básica

Añade la configuración del webhook a tu archivo de configuración del Gateway:

```yaml
automation:
  webhook:
    # URL de tu servidor donde se enviarán los webhooks
    url: https://tu-dominio.com/webhooks/openclaw

    # Secreto opcional para verificar la autenticidad del webhook
    # Envía este valor en el encabezado X-OpenClaw-Signature
    secret: tu-secreto-seguro-aqui

    # Opcional: tiempo de espera para solicitudes de webhook (predeterminado: 10s)
    timeout: 10s

    # Opcional: número de reintentos en caso de fallo (predeterminado: 3)
    retries: 3
```

### Configuración del endpoint del webhook

Tu servidor debe:

1. **Aceptar solicitudes POST** en la URL configurada
2. **Responder rápidamente** (idealmente < 5s) para evitar tiempos de espera
3. **Devolver códigos de estado 2xx** para indicar recepción exitosa
4. **Verificar la firma** si has configurado un secreto

Ejemplo de un endpoint de webhook simple en Node.js:

```javascript
const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.json());

const WEBHOOK_SECRET = "tu-secreto-seguro-aqui";

app.post("/webhooks/openclaw", (req, res) => {
  // Verificar firma si se configuró un secreto
  if (WEBHOOK_SECRET) {
    const signature = req.headers["x-openclaw-signature"];
    const expectedSignature = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (signature !== expectedSignature) {
      return res.status(401).send("Firma inválida");
    }
  }

  // Procesar el evento del webhook
  const { event, data } = req.body;
  console.log(`Evento recibido: ${event}`, data);

  // Responder rápidamente
  res.status(200).send("OK");

  // Procesar el webhook de forma asíncrona
  processWebhookAsync(event, data);
});

app.listen(3000, () => {
  console.log("Servidor de webhooks escuchando en el puerto 3000");
});
```

## Formato del payload

Todos los webhooks envían un payload JSON con esta estructura:

```json
{
  "event": "tipo-evento",
  "timestamp": "2025-01-18T10:30:00Z",
  "gateway_id": "tu-gateway-id",
  "data": {
    // Datos específicos del evento
  }
}
```

### Campos comunes

- `event`: Tipo de evento (string)
- `timestamp`: Cuándo ocurrió el evento (ISO 8601)
- `gateway_id`: ID del Gateway que envió el webhook
- `data`: Objeto que contiene datos específicos del evento

## Tipos de eventos

### Eventos de mensajes

#### `message.received`

Se activa cuando el Gateway recibe un mensaje nuevo.

```json
{
  "event": "message.received",
  "timestamp": "2025-01-18T10:30:00Z",
  "gateway_id": "gateway-123",
  "data": {
    "channel": "telegram",
    "from": "+1234567890",
    "to": "bot-id",
    "text": "Hola OpenClaw",
    "message_id": "msg-456"
  }
}
```

#### `message.sent`

Se activa cuando el Gateway envía un mensaje exitosamente.

```json
{
  "event": "message.sent",
  "timestamp": "2025-01-18T10:30:01Z",
  "gateway_id": "gateway-123",
  "data": {
    "channel": "telegram",
    "to": "+1234567890",
    "text": "Hola! ¿Cómo puedo ayudarte?",
    "message_id": "msg-457"
  }
}
```

### Eventos de canal

#### `channel.connected`

Se activa cuando un canal se conecta exitosamente.

```json
{
  "event": "channel.connected",
  "timestamp": "2025-01-18T10:25:00Z",
  "gateway_id": "gateway-123",
  "data": {
    "channel": "whatsapp",
    "account": "+1234567890"
  }
}
```

#### `channel.disconnected`

Se activa cuando un canal se desconecta.

```json
{
  "event": "channel.disconnected",
  "timestamp": "2025-01-18T10:35:00Z",
  "gateway_id": "gateway-123",
  "data": {
    "channel": "whatsapp",
    "account": "+1234567890",
    "reason": "Token de autenticación expirado"
  }
}
```

### Eventos del sistema

#### `gateway.started`

Se activa cuando el Gateway inicia.

```json
{
  "event": "gateway.started",
  "timestamp": "2025-01-18T10:00:00Z",
  "gateway_id": "gateway-123",
  "data": {
    "version": "2025.1.18",
    "mode": "local"
  }
}
```

#### `gateway.error`

Se activa cuando ocurre un error del sistema.

```json
{
  "event": "gateway.error",
  "timestamp": "2025-01-18T10:40:00Z",
  "gateway_id": "gateway-123",
  "data": {
    "error": "Error de conexión de base de datos",
    "details": "No se pudo conectar al servidor PostgreSQL"
  }
}
```

## Verificación de firma

Si configuras un `secret`, OpenClaw firma cada payload del webhook usando HMAC-SHA256. La firma se envía en el encabezado `X-OpenClaw-Signature`.

### Verificación de la firma en tu código

#### Node.js

```javascript
const crypto = require("crypto");

function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");

  return signature === expectedSignature;
}
```

#### Python

```python
import hmac
import hashlib
import json

def verify_webhook_signature(payload, signature, secret):
    expected_signature = hmac.new(
        secret.encode('utf-8'),
        json.dumps(payload).encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    return signature == expected_signature
```

#### Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
)

func verifyWebhookSignature(payload interface{}, signature, secret string) bool {
    payloadBytes, _ := json.Marshal(payload)

    h := hmac.New(sha256.New, []byte(secret))
    h.Write(payloadBytes)
    expectedSignature := hex.EncodeToString(h.Sum(nil))

    return signature == expectedSignature
}
```

## Reintentos y manejo de errores

OpenClaw reintenta automáticamente los webhooks fallidos según tu configuración:

- **Reintenta en caso de:** códigos de estado 5xx, tiempos de espera, errores de red
- **No reintenta en caso de:** códigos de estado 4xx (error del cliente)
- **Intervalo de reintento:** retroceso exponencial (1s, 2s, 4s, 8s...)
- **Reintentos máximos:** configurable (predeterminado: 3)

### Registro de entregas fallidas

Los webhooks fallidos se registran en los registros del Gateway:

```
[WARN] Webhook delivery failed: POST https://tu-dominio.com/webhooks/openclaw
       Status: 500, Attempt: 1/3, Retry in: 1s
```

## Mejores prácticas

### 1. Responde rápidamente

Reconoce el webhook de inmediato con un `200 OK` y procesa el payload de forma asíncrona:

```javascript
app.post("/webhooks/openclaw", async (req, res) => {
  // Reconoce inmediatamente
  res.status(200).send("OK");

  // Procesa de forma asíncrona
  processWebhookInBackground(req.body).catch((err) => {
    console.error("Error al procesar webhook:", err);
  });
});
```

### 2. Siempre verifica las firmas

Si configuras un secreto, siempre verifica la firma antes de procesar el payload:

```javascript
if (!verifyWebhookSignature(req.body, req.headers["x-openclaw-signature"], SECRET)) {
  return res.status(401).send("Firma inválida");
}
```

### 3. Maneja eventos duplicados

Debido a los reintentos, podrías recibir el mismo evento múltiples veces. Usa el `message_id` u otro identificador único para deduplicar:

```javascript
const processedEvents = new Set();

function processWebhook(event) {
  const eventId = event.data.message_id || `${event.event}-${event.timestamp}`;

  if (processedEvents.has(eventId)) {
    console.log("Evento duplicado ignorado:", eventId);
    return;
  }

  processedEvents.add(eventId);
  // Procesar evento...
}
```

### 4. Usa HTTPS

Siempre usa HTTPS para tu endpoint de webhooks para proteger los datos en tránsito.

### 5. Monitorea las entregas de webhooks

Configura alertas para webhooks fallidos monitoreando tus registros o usando un servicio como Sentry.

## Solución de problemas

### Los webhooks no se están enviando

1. Verifica que `automation.webhook.url` esté configurada en la configuración de tu Gateway
2. Asegúrate de que el Gateway esté en ejecución y conectado
3. Revisa los registros del Gateway para errores de webhook

### Los webhooks están fallando

1. Verifica que tu endpoint esté accesible desde el Gateway
2. Confirma que tu servidor responda dentro del tiempo de espera (predeterminado: 10s)
3. Revisa que tu endpoint devuelva códigos de estado 2xx
4. Si usas un secreto, verifica que la verificación de firma esté correcta

### Los webhooks están duplicados

Esto es esperado debido a los reintentos. Implementa deduplicación usando IDs de eventos únicos como se muestra arriba.

## Próximos pasos

- Aprende sobre [Hooks](/es-ES/automation/hooks) para ejecución local de código
- Configura [Tareas programadas](/es-ES/automation/cron-jobs) para automatización basada en tiempo
- Explora la [Referencia de configuración del Gateway](/es-ES/gateway/config) para opciones avanzadas
