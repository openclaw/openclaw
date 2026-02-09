---
summary: "Plugin de llamadas de voz: llamadas salientes + entrantes vía Twilio/Telnyx/Plivo (instalación del plugin + configuración + CLI)"
read_when:
  - Quiere realizar una llamada de voz saliente desde OpenClaw
  - Está configurando o desarrollando el plugin de llamadas de voz
title: "Plugin de Llamadas de Voz"
---

# Llamadas de Voz (plugin)

Llamadas de voz para OpenClaw mediante un plugin. Admite notificaciones salientes y
conversaciones de varios turnos con políticas de entrada.

Proveedores actuales:

- `twilio` (Programmable Voice + Media Streams)
- `telnyx` (Call Control v2)
- `plivo` (Voice API + XML transfer + GetInput speech)
- `mock` (dev/sin red)

Modelo mental rápido:

- Instalar el plugin
- Reiniciar el Gateway
- Configurar en `plugins.entries.voice-call.config`
- Usar `openclaw voicecall ...` o la herramienta `voice_call`

## Dónde se ejecuta (local vs remoto)

El plugin de Llamadas de Voz se ejecuta **dentro del proceso del Gateway**.

Si usa un Gateway remoto, instale/configure el plugin en la **máquina que ejecuta el Gateway**, luego reinicie el Gateway para cargarlo.

## Instalación

### Opción A: instalar desde npm (recomendado)

```bash
openclaw plugins install @openclaw/voice-call
```

Reinicie el Gateway después.

### Opción B: instalar desde una carpeta local (dev, sin copias)

```bash
openclaw plugins install ./extensions/voice-call
cd ./extensions/voice-call && pnpm install
```

Reinicie el Gateway después.

## Configuración

Establezca la configuración en `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio", // or "telnyx" | "plivo" | "mock"
          fromNumber: "+15550001234",
          toNumber: "+15550005678",

          twilio: {
            accountSid: "ACxxxxxxxx",
            authToken: "...",
          },

          plivo: {
            authId: "MAxxxxxxxxxxxxxxxxxxxx",
            authToken: "...",
          },

          // Webhook server
          serve: {
            port: 3334,
            path: "/voice/webhook",
          },

          // Webhook security (recommended for tunnels/proxies)
          webhookSecurity: {
            allowedHosts: ["voice.example.com"],
            trustedProxyIPs: ["100.64.0.1"],
          },

          // Public exposure (pick one)
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

- Twilio/Telnyx requieren una URL de webhook **accesible públicamente**.
- Plivo requiere una URL de webhook **accesible públicamente**.
- `mock` es un proveedor local de desarrollo (sin llamadas de red).
- `skipSignatureVerification` es solo para pruebas locales.
- Si usa el plan gratuito de ngrok, configure `publicUrl` con la URL exacta de ngrok; la verificación de firmas siempre se aplica.
- `tunnel.allowNgrokFreeTierLoopbackBypass: true` permite webhooks de Twilio con firmas inválidas **solo** cuando `tunnel.provider="ngrok"` y `serve.bind` es loopback (agente local de ngrok). Úselo solo para desarrollo local.
- Las URLs del plan gratuito de ngrok pueden cambiar o añadir comportamiento intersticial; si `publicUrl` se desvía, las firmas de Twilio fallarán. Para producción, prefiera un dominio estable o un funnel de Tailscale.

## Seguridad de Webhooks

Cuando un proxy o túnel se sitúa delante del Gateway, el plugin reconstruye la
URL pública para la verificación de firmas. Estas opciones controlan qué encabezados
reenviados son de confianza.

`webhookSecurity.allowedHosts` agrega a una lista de permitidos los hosts de los encabezados reenviados.

`webhookSecurity.trustForwardingHeaders` confía en los encabezados reenviados sin una lista de permitidos.

`webhookSecurity.trustedProxyIPs` solo confía en los encabezados reenviados cuando la IP remota
de la solicitud coincide con la lista.

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

Llamadas de Voz usa la configuración central de `messages.tts` (OpenAI o ElevenLabs) para
streaming de voz en llamadas. Puede sobrescribirla en la configuración del plugin con la
**misma forma** — se fusiona en profundidad con `messages.tts`.

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

- **Edge TTS se ignora para llamadas de voz** (el audio de telefonía necesita PCM; la salida de Edge es poco confiable).
- Se usa el TTS central cuando el streaming de medios de Twilio está habilitado; de lo contrario, las llamadas recurren a las voces nativas del proveedor.

### Más ejemplos

Usar solo el TTS central (sin sobrescritura):

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

Sobrescribir a ElevenLabs solo para llamadas (mantener el valor predeterminado central en otros lugares):

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

Sobrescribir solo el modelo de OpenAI para llamadas (ejemplo de fusión profunda):

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

La política de entrada predeterminada es `disabled`. Para habilitar llamadas entrantes, configure:

```json5
{
  inboundPolicy: "allowlist",
  allowFrom: ["+15550001234"],
  inboundGreeting: "Hello! How can I help?",
}
```

Las respuestas automáticas usan el sistema de agente. Ajuste con:

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

## Herramienta del agente

Nombre de la herramienta: `voice_call`

Acciones:

- `initiate_call` (message, to?, mode?)
- `continue_call` (callId, message)
- `speak_to_user` (callId, message)
- `end_call` (callId)
- `get_status` (callId)

Este repositorio incluye un documento de skill correspondiente en `skills/voice-call/SKILL.md`.

## RPC del Gateway

- `voicecall.initiate` (`to?`, `message`, `mode?`)
- `voicecall.continue` (`callId`, `message`)
- `voicecall.speak` (`callId`, `message`)
- `voicecall.end` (`callId`)
- `voicecall.status` (`callId`)
