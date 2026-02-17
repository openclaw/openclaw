---
summary: "Modo Conversación: conversaciones de voz continuas con TTS de ElevenLabs"
read_when:
  - Implementar modo Conversación en macOS/iOS/Android
  - Cambiar comportamiento de voz/TTS/interrupción
title: "Modo Conversación"
---

# Modo Conversación

El modo Conversación es un bucle de conversación de voz continua:

1. Escuchar voz
2. Enviar transcripción al modelo (sesión principal, chat.send)
3. Esperar la respuesta
4. Hablarla mediante ElevenLabs (reproducción en streaming)

## Comportamiento (macOS)

- **Superposición siempre activa** mientras el modo Conversación está habilitado.
- Transiciones de fase **Escuchando → Pensando → Hablando**.
- En una **pausa corta** (ventana de silencio), la transcripción actual se envía.
- Las respuestas se **escriben en WebChat** (igual que escribir).
- **Interrumpir al hablar** (predeterminado activado): si el usuario comienza a hablar mientras el asistente está hablando, detenemos la reproducción y anotamos la marca de tiempo de interrupción para el siguiente prompt.

## Directivas de voz en respuestas

El asistente puede prefijar su respuesta con una **sola línea JSON** para controlar la voz:

```json
{ "voice": "<voice-id>", "once": true }
```

Reglas:

- Solo primera línea no vacía.
- Las claves desconocidas se ignoran.
- `once: true` se aplica solo a la respuesta actual.
- Sin `once`, la voz se convierte en la nueva predeterminada para el modo Conversación.
- La línea JSON se elimina antes de la reproducción TTS.

Claves admitidas:

- `voice` / `voice_id` / `voiceId`
- `model` / `model_id` / `modelId`
- `speed`, `rate` (WPM), `stability`, `similarity`, `style`, `speakerBoost`
- `seed`, `normalize`, `lang`, `output_format`, `latency_tier`
- `once`

## Config (`~/.openclaw/openclaw.json`)

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

Predeterminados:

- `interruptOnSpeech`: true
- `voiceId`: recurre a `ELEVENLABS_VOICE_ID` / `SAG_VOICE_ID` (o primera voz de ElevenLabs cuando la clave de API está disponible)
- `modelId`: predeterminado a `eleven_v3` cuando no está establecido
- `apiKey`: recurre a `ELEVENLABS_API_KEY` (o perfil de shell del gateway si está disponible)
- `outputFormat`: predeterminado a `pcm_44100` en macOS/iOS y `pcm_24000` en Android (establece `mp3_*` para forzar streaming MP3)

## Interfaz macOS

- Interruptor de barra de menú: **Talk**
- Pestaña de configuración: grupo **Modo Conversación** (ID de voz + interruptor de interrupción)
- Superposición:
  - **Escuchando**: nube pulsa con nivel de micrófono
  - **Pensando**: animación de hundimiento
  - **Hablando**: anillos radiantes
  - Clic en nube: detener habla
  - Clic en X: salir del modo Conversación

## Notas

- Requiere permisos de Voz + Micrófono.
- Usa `chat.send` contra la clave de sesión `main`.
- TTS usa la API de streaming de ElevenLabs con `ELEVENLABS_API_KEY` y reproducción incremental en macOS/iOS/Android para menor latencia.
- `stability` para `eleven_v3` se valida a `0.0`, `0.5` o `1.0`; otros modelos aceptan `0..1`.
- `latency_tier` se valida a `0..4` cuando está establecido.
- Android admite formatos de salida `pcm_16000`, `pcm_22050`, `pcm_24000` y `pcm_44100` para streaming AudioTrack de baja latencia.
