---
summary: "Modo Talk: conversaciones de voz continuas con TTS de ElevenLabs"
read_when:
  - Implementación del modo Talk en macOS/iOS/Android
  - Cambio del comportamiento de voz/TTS/interrupción
title: "Modo Talk"
---

# Modo Talk

El modo Talk es un bucle continuo de conversación por voz:

1. Escuchar el habla
2. Enviar la transcripción al modelo (sesión principal, chat.send)
3. Esperar la respuesta
4. Reproducirla mediante ElevenLabs (reproducción en streaming)

## Comportamiento (macOS)

- **Overlay siempre activo** mientras el modo Talk está habilitado.
- Transiciones de fase **Escuchando → Pensando → Hablando**.
- En una **pausa corta** (ventana de silencio), se envía la transcripción actual.
- Las respuestas se **escriben en WebChat** (igual que al teclear).
- **Interrumpir al hablar** (activado por defecto): si el usuario empieza a hablar mientras el asistente está hablando, se detiene la reproducción y se anota la marca de tiempo de la interrupción para el siguiente prompt.

## Directivas de voz en las respuestas

El asistente puede anteponer su respuesta con **una sola línea JSON** para controlar la voz:

```json
{ "voice": "<voice-id>", "once": true }
```

Reglas:

- Solo la primera línea no vacía.
- Las claves desconocidas se ignoran.
- `once: true` se aplica solo a la respuesta actual.
- Sin `once`, la voz pasa a ser el nuevo valor predeterminado para el modo Talk.
- La línea JSON se elimina antes de la reproducción TTS.

Claves compatibles:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Configuración (`~/.openclaw/openclaw.json`)

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

Valores predeterminados:

- `interruptOnSpeech`: true
- `voiceId`: recurre a `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (o a la primera voz de ElevenLabs cuando la clave de API está disponible)
- `modelId`: por defecto `eleven_v3` cuando no se establece
- `apiKey`: recurre a `ELEVENLABS_API_KEY` (o al perfil de shell del gateway si está disponible)
- `outputFormat`: por defecto `pcm_44100` en macOS/iOS y `pcm_24000` en Android (establezca `mp3_*` para forzar streaming MP3)

## UI de macOS

- Alternador en la barra de menús: **Talk**
- Pestaña de configuración: grupo **Modo Talk** (ID de voz + alternador de interrupción)
- Overlay:
  - **Escuchando**: pulsos de nube con nivel de micrófono
  - **Pensando**: animación descendente
  - **Hablando**: anillos radiantes
  - Clic en la nube: detener el habla
  - Clic en X: salir del modo Talk

## Notas

- Requiere permisos de Voz + Micrófono.
- Usa `chat.send` contra la clave de sesión `main`.
- El TTS utiliza la API de streaming de ElevenLabs con `ELEVENLABS_API_KEY` y reproducción incremental en macOS/iOS/Android para menor latencia.
- `stability` para `eleven_v3` se valida a `0.0`, `0.5` o `1.0`; otros modelos aceptan `0..1`.
- `latency_tier` se valida a `0..4` cuando se establece.
- Android admite los formatos de salida `pcm_16000`, `pcm_22050`, `pcm_24000` y `pcm_44100` para streaming AudioTrack de baja latencia.
