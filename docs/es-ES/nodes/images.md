---
summary: "Reglas de manejo de imágenes y medios para envío, gateway y respuestas del agente"
read_when:
  - Modificar pipeline de medios o adjuntos
title: "Soporte de Imágenes y Medios"
---

# Soporte de Imágenes y Medios — 2025-12-05

El canal de WhatsApp se ejecuta mediante **Baileys Web**. Este documento captura las reglas actuales de manejo de medios para envío, gateway y respuestas del agente.

## Objetivos

- Enviar medios con subtítulos opcionales mediante `openclaw message send --media`.
- Permitir respuestas automáticas desde la bandeja de entrada web para incluir medios junto con texto.
- Mantener los límites por tipo sensatos y predecibles.

## Superficie CLI

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` opcional; el subtítulo puede estar vacío para envíos solo de medios.
  - `--dry-run` imprime la carga útil resuelta; `--json` emite `{ channel, to, messageId, mediaUrl, caption }`.

## Comportamiento del canal WhatsApp Web

- Entrada: ruta de archivo local **o** URL HTTP(S).
- Flujo: cargar en un Buffer, detectar tipo de medios y construir la carga útil correcta:
  - **Imágenes:** redimensionar y recomprimir a JPEG (lado máximo 2048px) apuntando a `agents.defaults.mediaMaxMb` (predeterminado 5 MB), limitado a 6 MB.
  - **Audio/Voz/Video:** paso directo hasta 16 MB; el audio se envía como nota de voz (`ptt: true`).
  - **Documentos:** cualquier otra cosa, hasta 100 MB, con el nombre del archivo preservado cuando está disponible.
- Reproducción estilo GIF de WhatsApp: enviar un MP4 con `gifPlayback: true` (CLI: `--gif-playback`) para que los clientes móviles reproduzcan en bucle en línea.
- La detección MIME prefiere bytes mágicos, luego encabezados, luego extensión de archivo.
- El subtítulo proviene de `--message` o `reply.text`; se permite subtítulo vacío.
- Registro: no verbose muestra `↩️`/`✅`; verbose incluye tamaño y ruta/URL de origen.

## Pipeline de respuesta automática

- `getReplyFromConfig` devuelve `{ text?, mediaUrl?, mediaUrls? }`.
- Cuando hay medios presentes, el remitente web resuelve rutas locales o URLs usando el mismo pipeline que `openclaw message send`.
- Múltiples entradas de medios se envían secuencialmente si se proporcionan.

## Medios entrantes a comandos (Pi)

- Cuando los mensajes web entrantes incluyen medios, OpenClaw descarga a un archivo temporal y expone variables de plantilla:
  - `{{MediaUrl}}` pseudo-URL para los medios entrantes.
  - `{{MediaPath}}` ruta temporal local escrita antes de ejecutar el comando.
- Cuando se habilita un sandbox Docker por sesión, los medios entrantes se copian en el espacio de trabajo del sandbox y `MediaPath`/`MediaUrl` se reescriben a una ruta relativa como `media/inbound/<filename>`.
- La comprensión de medios (si se configura mediante `tools.media.*` o `tools.media.models` compartido) se ejecuta antes de la plantilla y puede insertar bloques `[Image]`, `[Audio]` y `[Video]` en `Body`.
  - El audio establece `{{Transcript}}` y usa la transcripción para el análisis de comandos para que los comandos slash aún funcionen.
  - Las descripciones de video e imagen preservan cualquier texto de subtítulo para el análisis de comandos.
- De forma predeterminada, solo se procesa el primer adjunto de imagen/audio/video coincidente; establece `tools.media.<cap>.attachments` para procesar múltiples adjuntos.

## Límites y errores

**Límites de envío saliente (envío web WhatsApp)**

- Imágenes: límite ~6 MB después de recompresión.
- Audio/voz/video: límite 16 MB; documentos: límite 100 MB.
- Medios sobredimensionados o ilegibles → error claro en registros y la respuesta se omite.

**Límites de comprensión de medios (transcripción/descripción)**

- Imagen predeterminado: 10 MB (`tools.media.image.maxBytes`).
- Audio predeterminado: 20 MB (`tools.media.audio.maxBytes`).
- Video predeterminado: 50 MB (`tools.media.video.maxBytes`).
- Los medios sobredimensionados omiten la comprensión, pero las respuestas aún continúan con el cuerpo original.

## Notas para pruebas

- Cubrir flujos de envío + respuesta para casos de imagen/audio/documento.
- Validar recompresión para imágenes (límite de tamaño) y bandera de nota de voz para audio.
- Asegurar que las respuestas multimedia se distribuyan como envíos secuenciales.
