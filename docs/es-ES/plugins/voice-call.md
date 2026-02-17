---
summary: "Plugin de Llamadas de Voz: llamadas salientes + entrantes vía Twilio/Telnyx/Plivo (instalación de plugin + configuración + CLI)"
read_when:
  - Quieres realizar una llamada de voz saliente desde OpenClaw
  - Estás configurando o desarrollando el plugin de llamadas de voz
title: "Plugin de Llamadas de Voz"
---

# Llamadas de Voz (plugin)

Llamadas de voz para OpenClaw mediante un plugin. Admite notificaciones salientes y
conversaciones de múltiples turnos con políticas de entrada.

Proveedores actuales:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/sin red)

Modelo mental rápido:

- Instalar plugin
- Reiniciar Gateway
- Configurar bajo `plugins.entries.voice-call.config`
- Usar `openclaw voicecall ...` o la herramienta `voice_call`

## Dónde se ejecuta (local vs remoto)

El plugin de Llamadas de Voz se ejecuta **dentro del proceso del Gateway**.

Si usas un Gateway remoto, instala/configura el plugin en la **máquina que ejecuta el Gateway**, luego reinicia el Gateway para cargarlo.

## Instalación

### Opción A: instalar desde npm (recomendado)

```bash
openclaw plugins install @openclaw/voice-call
```

Reinicia el Gateway después.

### Opción B: instalar desde una carpeta local (dev, sin copiar)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Reinicia el Gateway después.

## Configuración

Configura bajo `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // o "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          telnyx: {
            apiKey: "...",
            connectionId: "...",
            // Clave pública de webhook de Telnyx del Portal Telnyx Mission Control
            // (cadena Base64; también se puede establecer vía TELNYX_PUBLIC_KEY).
            publicKey: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Servidor de webhook
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Seguridad del webhook (recomendado para túneles/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Exposición pública (elige una)
          // publicUrl: "https://example.ngrok.app/voice/webhook",
          // tunnel: { provider: "ngrok" },
          // tailscale: { mode: "funnel", path: "/voice/webhook" }

          outbound: {
            defaultMode: "notify", // notify | conversation
          },

          streaming: {
            enabled: true,
            streamPath: "/voice/stream",
          },
        },
      },
    },
  },
}
```

Notas:

- Twilio/Telnyx requieren una URL de webhook **públicamente accesible**.
- Plivo requiere una URL de webhook **públicamente accesible**.
- `mock` es un proveedor de desarrollo local (sin llamadas de red).
- Telnyx requiere `telnyx.publicKey` (o `TELNYX_PUBLIC_KEY`) a menos que `skipSignatureVerification` sea true.
- `skipSignatureVerification` es solo para pruebas locales.
- Si usas el nivel gratuito de ngrok, establece `publicUrl` a la URL exacta de ngrok; la verificación de firma siempre se aplica.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` permite webhooks de Twilio con firmas inválidas **solo** cuando `tunnel.provider="ngrok"` y `serve.bind` es loopback (agente local de ngrok). Usa solo para desarrollo local.
- Las URLs del nivel gratuito de ngrok pueden cambiar o agregar comportamiento intersticial; si `publicUrl` se desvía, las firmas de Twilio fallarán. Para producción, prefiere un dominio estable o funnel de Tailscale.

## Seguridad del Webhook

Cuando un proxy o túnel está frente al Gateway, el plugin reconstruye la
URL pública para verificación de firma. Estas opciones controlan qué encabezados
reenviados son confiables.

`webhookSecurity.allowedHosts` lista permitida de hosts desde encabezados de reenvío.

`webhookSecurity.trustForwardingHeaders` confía en encabezados reenviados sin una lista permitida.

`webhookSecurity.trustedProxyIPs` solo confía en encabezados reenviados cuando la IP
remota de la solicitud coincide con la lista.

Ejemplo con un host público estable:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          publicUrl: "https://voice.example.com/voice/webhook",
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
          },
        },
      },
    },
  },
}
```

## TTS para llamadas

Llamadas de Voz usa la configuración principal `messages.tts` (OpenAI o ElevenLabs) para
voz de streaming en llamadas. Puedes anularla bajo la configuración del plugin con la
**misma estructura** — se combina profundamente con `messages.tts`.

```json5
{
  tts: {
    provider: "elevenlabs",
    elevenlabs: {
      voiceId: "pMsXgVXv3BLzUgSXRplE",
      modelId: "eleven_multilingual_v2",
    },
  },
}
```

Notas:

- **Edge TTS se ignora para llamadas de voz** (el audio de telefonía necesita PCM; la salida de Edge no es confiable).
- Se usa TTS del núcleo cuando el streaming de medios de Twilio está habilitado; de lo contrario, las llamadas recurren a voces nativas del proveedor.

### Más ejemplos

Usar solo TTS del núcleo (sin anulación):

```json5
{
  messages: {
    tts: {
      provider: "openai",
      openai: { voice: "alloy" },
    },
  },
}
```

Anular a ElevenLabs solo para llamadas (mantener el predeterminado del núcleo en otros lugares):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            provider: "elevenlabs",
            elevenlabs: {
              apiKey: "elevenlabs_key",
              voiceId: "pMsXgVXv3BLzUgSXRplE",
              modelId: "eleven_multilingual_v2",
            },
          },
        },
      },
    },
  },
}
```

Anular solo el modelo de OpenAI para llamadas (ejemplo de combinación profunda):

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          tts: {
            openai: {
              model: "gpt-4o-mini-tts",
              voice: "marin",
            },
          },
        },
      },
    },
  },
}
```

## Llamadas entrantes

La política de entrada por defecto es `disabled`. Para habilitar llamadas entrantes, establece:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Las respuestas automáticas usan el sistema de agente. Ajusta con:

- `responseModel`
- `responseSystemPrompt`
- `responseTimeoutMs`

## CLI

```bash
openclaw voicecall call --to "+15555550123" --message "Hello from OpenClaw"
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall speak --call-id <id> --message "One moment"
openclaw voicecall end --call-id <id>
openclaw voicecall status --call-id <id>
openclaw voicecall tail
openclaw voicecall expose --mode funnel
```

## Herramienta de agente

Nombre de herramienta: `voice_call`

Acciones:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Este repositorio incluye un documento de habilidad correspondiente en `skills/voice-call/SKILL.md`.

## Gateway RPC

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
