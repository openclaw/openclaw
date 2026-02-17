---
summary: "Texto a voz (TTS) para respuestas salientes"
read_when:
  - Habilitar texto a voz para respuestas
  - Configurar proveedores o límites de TTS
  - Usar comandos /tts
title: "Texto a Voz"
---

# Texto a voz (TTS)

OpenClaw puede convertir respuestas salientes en audio usando ElevenLabs, OpenAI o Edge TTS.
Funciona en cualquier lugar donde OpenClaw pueda enviar audio; Telegram obtiene una burbuja redonda de nota de voz.

## Servicios compatibles

- **ElevenLabs** (proveedor principal o de respaldo)
- **OpenAI** (proveedor principal o de respaldo; también usado para resúmenes)
- **Edge TTS** (proveedor principal o de respaldo; usa `node-edge-tts`, predeterminado cuando no hay claves de API)

### Notas sobre Edge TTS

Edge TTS usa el servicio TTS neural en línea de Microsoft Edge mediante la biblioteca
`node-edge-tts`. Es un servicio alojado (no local), usa los endpoints de Microsoft y no
requiere una clave de API. `node-edge-tts` expone opciones de configuración de voz y
formatos de salida, pero no todas las opciones son compatibles con el servicio Edge. citeturn2search0

Debido a que Edge TTS es un servicio web público sin un SLA publicado o cuota, trátalo
como mejor esfuerzo. Si necesitas límites y soporte garantizados, usa OpenAI o ElevenLabs.
La API REST de Speech de Microsoft documenta un límite de audio de 10 minutos por solicitud;
Edge TTS no publica límites, por lo que asume límites similares o inferiores. citeturn0search3

## Claves opcionales

Si deseas OpenAI o ElevenLabs:

- `ELEVENLABS_API_KEY` (o `XI_API_KEY`)
- `OPENAI_API_KEY`

Edge TTS **no** requiere una clave de API. Si no se encuentran claves de API, OpenClaw utiliza
Edge TTS por defecto (a menos que se deshabilite mediante `messages.tts.edge.enabled=false`).

Si se configuran múltiples proveedores, el proveedor seleccionado se usa primero y los otros son opciones de respaldo.
El resumen automático usa el `summaryModel` configurado (o `agents.defaults.model.primary`),
por lo que ese proveedor también debe estar autenticado si habilitas resúmenes.

## Enlaces de servicios

- [Guía de Texto a voz de OpenAI](https://platform.openai.com/docs/guides/text-to-speech)
- [Referencia de API de Audio de OpenAI](https://platform.openai.com/docs/api-reference/audio)
- [Texto a voz de ElevenLabs](https://elevenlabs.io/docs/api-reference/text-to-speech)
- [Autenticación de ElevenLabs](https://elevenlabs.io/docs/api-reference/authentication)
- [node-edge-tts](https://github.com/SchneeHertz/node-edge-tts)
- [Formatos de salida de voz de Microsoft](https://learn.microsoft.com/azure/ai-services/speech-service/rest-text-to-speech#audio-outputs)

## ¿Está habilitado por defecto?

No. El TTS automático está **desactivado** por defecto. Habilítalo en la configuración con
`messages.tts.auto` o por sesión con `/tts always` (alias: `/tts on`).

Edge TTS **está** habilitado por defecto una vez que TTS está activado, y se usa automáticamente
cuando no hay claves de API de OpenAI o ElevenLabs disponibles.

## Configuración

La configuración de TTS reside bajo `messages.tts` en `openclaw.json`.
El esquema completo está en [Configuración del Gateway](/es-ES/gateway/configuration).

### Configuración mínima (habilitar + proveedor)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "elevenlabs",
    },
  },
}
```

### OpenAI principal con ElevenLabs de respaldo

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "openai",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
    },
  },
}
```

### Edge TTS principal (sin clave de API)

```json5
{
  messages: {
    tts: {
      auto: "always",
      provider: "edge",
      edge: {
        enabled: true,
        voice: "en-US-MichelleNeural",
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        rate: "+10%",
        pitch: "-5%",
      },
    },
  },
}
```

### Deshabilitar Edge TTS

```json5
{
  messages: {
    tts: {
      edge: {
        enabled: false,
      },
    },
  },
}
```

### Límites personalizados + ruta de preferencias

```json5
{
  messages: {
    tts: {
      auto: "always",
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
    },
  },
}
```

### Solo responder con audio después de una nota de voz entrante

```json5
{
  messages: {
    tts: {
      auto: "inbound",
    },
  },
}
```

### Deshabilitar resumen automático para respuestas largas

```json5
{
  messages: {
    tts: {
      auto: "always",
    },
  },
}
```

Luego ejecuta:

```
/tts summary off
```

### Notas sobre campos

- `auto`: modo de TTS automático (`off`, `always`, `inbound`, `tagged`).
  - `inbound` solo envía audio después de una nota de voz entrante.
  - `tagged` solo envía audio cuando la respuesta incluye etiquetas `[[tts]]`.
- `enabled`: interruptor heredado (doctor lo migra a `auto`).
- `mode`: `"final"` (predeterminado) o `"all"` (incluye respuestas de herramientas/bloques).
- `provider`: `"elevenlabs"`, `"openai"` o `"edge"` (el respaldo es automático).
- Si `provider` **no está configurado**, OpenClaw prefiere `openai` (si hay clave), luego `elevenlabs` (si hay clave),
  de lo contrario `edge`.
- `summaryModel`: modelo económico opcional para resumen automático; por defecto `agents.defaults.model.primary`.
  - Acepta `provider/model` o un alias de modelo configurado.
- `modelOverrides`: permite que el modelo emita directivas de TTS (activado por defecto).
- `maxTextLength`: límite máximo para entrada de TTS (caracteres). `/tts audio` falla si se excede.
- `timeoutMs`: tiempo de espera de solicitud (ms).
- `prefsPath`: anula la ruta del JSON de preferencias locales (proveedor/límite/resumen).
- Los valores de `apiKey` retroceden a variables de entorno (`ELEVENLABS_API_KEY`/`XI_API_KEY`, `OPENAI_API_KEY`).
- `elevenlabs.baseUrl`: anula la URL base de la API de ElevenLabs.
- `elevenlabs.voiceSettings`:
  - `stability`, `similarityBoost`, `style`: `0..1`
  - `useSpeakerBoost`: `true|false`
  - `speed`: `0.5..2.0` (1.0 = normal)
- `elevenlabs.applyTextNormalization`: `auto|on|off`
- `elevenlabs.languageCode`: ISO 639-1 de 2 letras (ej. `en`, `de`)
- `elevenlabs.seed`: entero `0..4294967295` (determinismo de mejor esfuerzo)
- `edge.enabled`: permite el uso de Edge TTS (predeterminado `true`; sin clave de API).
- `edge.voice`: nombre de voz neural de Edge (ej. `en-US-MichelleNeural`).
- `edge.lang`: código de idioma (ej. `en-US`).
- `edge.outputFormat`: formato de salida de Edge (ej. `audio-24khz-48kbitrate-mono-mp3`).
  - Ver formatos de salida de voz de Microsoft para valores válidos; no todos los formatos son compatibles con Edge.
- `edge.rate` / `edge.pitch` / `edge.volume`: cadenas de porcentaje (ej. `+10%`, `-5%`).
- `edge.saveSubtitles`: escribe subtítulos JSON junto al archivo de audio.
- `edge.proxy`: URL de proxy para solicitudes de Edge TTS.
- `edge.timeoutMs`: anulación de tiempo de espera de solicitud (ms).

## Anulaciones impulsadas por el modelo (predeterminado activado)

Por defecto, el modelo **puede** emitir directivas de TTS para una sola respuesta.
Cuando `messages.tts.auto` es `tagged`, estas directivas son requeridas para activar el audio.

Cuando está habilitado, el modelo puede emitir directivas `[[tts:...]]` para anular la voz
para una sola respuesta, además de un bloque opcional `[[tts:text]]...[[/tts:text]]` para
proporcionar etiquetas expresivas (risas, señales de canto, etc.) que solo deben aparecer en
el audio.

Ejemplo de carga útil de respuesta:

```
Aquí tienes.

[[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE model=eleven_v3 speed=1.1]]
[[tts:text]](risas) Lee la canción una vez más.[[/tts:text]]
```

Claves de directiva disponibles (cuando está habilitado):

- `provider` (`openai` | `elevenlabs` | `edge`)
- `voice` (voz de OpenAI) o `voiceId` (ElevenLabs)
- `model` (modelo TTS de OpenAI o id de modelo de ElevenLabs)
- `stability`, `similarityBoost`, `style`, `speed`, `useSpeakerBoost`
- `applyTextNormalization` (`auto|on|off`)
- `languageCode` (ISO 639-1)
- `seed`

Deshabilitar todas las anulaciones del modelo:

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: false,
      },
    },
  },
}
```

Lista permitida opcional (deshabilitar anulaciones específicas mientras se mantienen las etiquetas habilitadas):

```json5
{
  messages: {
    tts: {
      modelOverrides: {
        enabled: true,
        allowProvider: false,
        allowSeed: false,
      },
    },
  },
}
```

## Preferencias por usuario

Los comandos slash escriben anulaciones locales en `prefsPath` (predeterminado:
`~/.openclaw/settings/tts.json`, anular con `OPENCLAW_TTS_PREFS` o
`messages.tts.prefsPath`).

Campos almacenados:

- `enabled`
- `provider`
- `maxLength` (umbral de resumen; predeterminado 1500 caracteres)
- `summarize` (predeterminado `true`)

Estos anulan `messages.tts.*` para ese host.

## Formatos de salida (fijos)

- **Telegram**: Nota de voz Opus (`opus_48000_64` de ElevenLabs, `opus` de OpenAI).
  - 48kHz / 64kbps es un buen equilibrio para notas de voz y es requerido para la burbuja redonda.
- **Otros canales**: MP3 (`mp3_44100_128` de ElevenLabs, `mp3` de OpenAI).
  - 44.1kHz / 128kbps es el equilibrio predeterminado para claridad de voz.
- **Edge TTS**: usa `edge.outputFormat` (predeterminado `audio-24khz-48kbitrate-mono-mp3`).
  - `node-edge-tts` acepta un `outputFormat`, pero no todos los formatos están disponibles
    desde el servicio Edge. citeturn2search0
  - Los valores de formato de salida siguen los formatos de salida de voz de Microsoft (incluyendo Ogg/WebM Opus). citeturn1search0
  - Telegram `sendVoice` acepta OGG/MP3/M4A; usa OpenAI/ElevenLabs si necesitas
    notas de voz Opus garantizadas. citeturn1search1
  - Si el formato de salida de Edge configurado falla, OpenClaw reintenta con MP3.

Los formatos de OpenAI/ElevenLabs son fijos; Telegram espera Opus para UX de nota de voz.

## Comportamiento de TTS automático

Cuando está habilitado, OpenClaw:

- omite TTS si la respuesta ya contiene medios o una directiva `MEDIA:`.
- omite respuestas muy cortas (< 10 caracteres).
- resume respuestas largas cuando está habilitado usando `agents.defaults.model.primary` (o `summaryModel`).
- adjunta el audio generado a la respuesta.

Si la respuesta excede `maxLength` y el resumen está desactivado (o no hay clave de API para el
modelo de resumen), el audio
se omite y se envía la respuesta de texto normal.

## Diagrama de flujo

```
Respuesta -> ¿TTS habilitado?
  no  -> enviar texto
  sí -> ¿tiene medios / MEDIA: / corta?
          sí -> enviar texto
          no  -> ¿longitud > límite?
                   no  -> TTS -> adjuntar audio
                   sí -> ¿resumen habilitado?
                            no  -> enviar texto
                            sí -> resumir (summaryModel o agents.defaults.model.primary)
                                      -> TTS -> adjuntar audio
```

## Uso de comandos slash

Hay un solo comando: `/tts`.
Ver [Comandos slash](/es-ES/tools/slash-commands) para detalles de habilitación.

Nota de Discord: `/tts` es un comando integrado de Discord, por lo que OpenClaw registra
`/voice` como el comando nativo allí. El texto `/tts ...` todavía funciona.

```
/tts off
/tts always
/tts inbound
/tts tagged
/tts status
/tts provider openai
/tts limit 2000
/tts summary off
/tts audio Hola desde OpenClaw
```

Notas:

- Los comandos requieren un remitente autorizado (las reglas de lista permitida/propietario aún se aplican).
- `commands.text` o el registro de comandos nativos debe estar habilitado.
- `off|always|inbound|tagged` son interruptores por sesión (`/tts on` es un alias de `/tts always`).
- `limit` y `summary` se almacenan en preferencias locales, no en la configuración principal.
- `/tts audio` genera una respuesta de audio única (no activa TTS).

## Herramienta de agente

La herramienta `tts` convierte texto a voz y devuelve una ruta `MEDIA:`. Cuando el
resultado es compatible con Telegram, la herramienta incluye `[[audio_as_voice]]` para que
Telegram envíe una burbuja de voz.

## RPC del Gateway

Métodos del Gateway:

- `tts.status`
- `tts.enable`
- `tts.disable`
- `tts.convert`
- `tts.setProvider`
- `tts.providers`
