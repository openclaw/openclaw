---
summary: "Cómo se descargan, transcriben e inyectan las notas de audio/voz entrantes en las respuestas"
read_when:
  - Cambiar transcripción de audio o manejo de medios
title: "Audio y Notas de Voz"
---

# Audio / Notas de Voz — 2026-01-17

## Lo que funciona

- **Comprensión de medios (audio)**: Si la comprensión de audio está habilitada (o detectada automáticamente), OpenClaw:
  1. Localiza el primer adjunto de audio (ruta local o URL) y lo descarga si es necesario.
  2. Aplica `maxBytes` antes de enviar a cada entrada de modelo.
  3. Ejecuta la primera entrada de modelo elegible en orden (proveedor o CLI).
  4. Si falla u omite (tamaño/tiempo de espera), intenta la siguiente entrada.
  5. Si tiene éxito, reemplaza `Body` con un bloque `[Audio]` y establece `{{Transcript}}`.
- **Análisis de comandos**: Cuando la transcripción tiene éxito, `CommandBody`/`RawBody` se establecen en la transcripción para que los comandos slash aún funcionen.
- **Registro verbose**: En `--verbose`, registramos cuando se ejecuta la transcripción y cuando reemplaza el cuerpo.

## Detección automática (predeterminado)

Si **no configuras modelos** y `tools.media.audio.enabled` **no** está establecido en `false`, OpenClaw detecta automáticamente en este orden y se detiene en la primera opción que funciona:

1. **CLIs locales** (si están instalados)
   - `sherpa-onnx-offline` (requiere `SHERPA_ONNX_MODEL_DIR` con encoder/decoder/joiner/tokens)
   - `whisper-cli` (de `whisper-cpp`; usa `WHISPER_CPP_MODEL` o el modelo tiny incluido)
   - `whisper` (CLI de Python; descarga modelos automáticamente)
2. **CLI Gemini** (`gemini`) usando `read_many_files`
3. **Claves de proveedor** (OpenAI → Groq → Deepgram → Google)

Para deshabilitar la detección automática, establece `tools.media.audio.enabled: false`.
Para personalizar, establece `tools.media.audio.models`.
Nota: La detección binaria es de mejor esfuerzo en macOS/Linux/Windows; asegúrate de que el CLI esté en `PATH` (expandimos `~`), o establece un modelo CLI explícito con una ruta de comando completa.

## Ejemplos de configuración

### Proveedor + respaldo CLI (OpenAI + Whisper CLI)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
            timeoutSeconds: 45,
          },
        ],
      },
    },
  },
}
```

### Solo proveedor con control de alcance

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        scope: {
          default: "allow",
          rules: [{ action: "deny", match: { chatType: "group" } }],
        },
        models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
      },
    },
  },
}
```

### Solo proveedor (Deepgram)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Notas y límites

- La autenticación del proveedor sigue el orden de autenticación de modelo estándar (perfiles de autenticación, variables de entorno, `models.providers.*.apiKey`).
- Deepgram recoge `DEEPGRAM_API_KEY` cuando se usa `provider: "deepgram"`.
- Detalles de configuración de Deepgram: [Deepgram (transcripción de audio)](/es-ES/providers/deepgram).
- Los proveedores de audio pueden anular `baseUrl`, `headers` y `providerOptions` mediante `tools.media.audio`.
- El límite de tamaño predeterminado es 20MB (`tools.media.audio.maxBytes`). El audio sobredimensionado se omite para ese modelo y se intenta la siguiente entrada.
- `maxChars` predeterminado para audio **no está establecido** (transcripción completa). Establece `tools.media.audio.maxChars` o `maxChars` por entrada para recortar la salida.
- El predeterminado automático de OpenAI es `gpt-4o-mini-transcribe`; establece `model: "gpt-4o-transcribe"` para mayor precisión.
- Usa `tools.media.audio.attachments` para procesar múltiples notas de voz (`mode: "all"` + `maxAttachments`).
- La transcripción está disponible para plantillas como `{{Transcript}}`.
- El stdout de CLI está limitado (5MB); mantén la salida de CLI concisa.

## Detección de menciones en grupos

Cuando `requireMention: true` está establecido para un chat de grupo, OpenClaw ahora transcribe audio **antes** de verificar menciones. Esto permite que las notas de voz se procesen incluso cuando contienen menciones.

**Cómo funciona:**

1. Si un mensaje de voz no tiene cuerpo de texto y el grupo requiere menciones, OpenClaw realiza una transcripción "preflight".
2. La transcripción se verifica en busca de patrones de mención (ej. `@BotName`, disparadores emoji).
3. Si se encuentra una mención, el mensaje procede a través del pipeline de respuesta completo.
4. La transcripción se usa para la detección de menciones para que las notas de voz puedan pasar la puerta de mención.

**Comportamiento de respaldo:**

- Si la transcripción falla durante preflight (tiempo de espera, error de API, etc.), el mensaje se procesa según la detección de menciones solo de texto.
- Esto asegura que los mensajes mixtos (texto + audio) nunca se descarten incorrectamente.

**Ejemplo:** Un usuario envía una nota de voz diciendo "Oye @Claude, ¿cómo está el clima?" en un grupo de Telegram con `requireMention: true`. La nota de voz se transcribe, se detecta la mención y el agente responde.

## Problemas

- Las reglas de alcance usan primer-coincidencia-gana. `chatType` se normaliza a `direct`, `group` o `room`.
- Asegúrate de que tu CLI salga con 0 e imprima texto plano; JSON necesita ser procesado mediante `jq -r .text`.
- Mantén tiempos de espera razonables (`timeoutSeconds`, predeterminado 60s) para evitar bloquear la cola de respuestas.
- La transcripción preflight solo procesa el **primer** adjunto de audio para la detección de menciones. El audio adicional se procesa durante la fase principal de comprensión de medios.
