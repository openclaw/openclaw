---
summary: "Modos de activación por voz y pulsar para hablar, además de detalles de enrutamiento en la app para mac"
read_when:
  - Al trabajar en rutas de activación por voz o PTT
title: "Activación por voz"
---

# Activación por voz y pulsar para hablar

## Modos

- **Modo de palabra de activación** (predeterminado): el reconocedor de voz siempre activo espera tokens de activación (`swabbleTriggerWords`). Al coincidir, inicia la captura, muestra la superposición con texto parcial y envía automáticamente tras el silencio.
- **Pulsar para hablar (mantener Opción derecha)**: mantenga presionada la tecla Opción derecha para capturar de inmediato—no se necesita activador. La superposición aparece mientras se mantiene; al soltar, finaliza y reenvía tras un breve retraso para que pueda ajustar el texto.

## Comportamiento en tiempo de ejecución (palabra de activación)

- El reconocedor de voz vive en `VoiceWakeRuntime`.
- El disparador solo se activa cuando hay una **pausa significativa** entre la palabra de activación y la siguiente palabra (~0.55 s de intervalo). La superposición/el sonido puede comenzar en la pausa incluso antes de que empiece el comando.
- Ventanas de silencio: 2.0 s cuando el habla fluye, 5.0 s si solo se escuchó el activador.
- Detención forzada: 120 s para evitar sesiones descontroladas.
- Antirrebote entre sesiones: 350 ms.
- La superposición se controla vía `VoiceWakeOverlayController` con coloración de confirmado/volátil.
- Tras el envío, el reconocedor se reinicia limpiamente para escuchar el siguiente activador.

## Invariantes del ciclo de vida

- Si Activación por voz está habilitada y los permisos están concedidos, el reconocedor de palabra de activación debe estar escuchando (excepto durante una captura explícita de pulsar para hablar).
- La visibilidad de la superposición (incluida la ocultación manual mediante el botón X) nunca debe impedir que el reconocedor se reanude.

## Modo de fallo de superposición persistente (anterior)

Anteriormente, si la superposición quedaba visible y usted la cerraba manualmente, Activación por voz podía parecer “muerta” porque el intento de reinicio del runtime podía quedar bloqueado por la visibilidad de la superposición y no se programaba ningún reinicio posterior.

Refuerzo:

- El reinicio del runtime de activación ya no se bloquea por la visibilidad de la superposición.
- La finalización de la ocultación de la superposición dispara un `VoiceWakeRuntime.refresh(...)` vía `VoiceSessionCoordinator`, de modo que el cierre manual con X siempre reanuda la escucha.

## Detalles de pulsar para hablar

- La detección de atajos usa un monitor global `.flagsChanged` para **Opción derecha** (`keyCode 61` + `.option`). Solo observamos eventos (sin consumirlos).
- La canalización de captura vive en `VoicePushToTalk`: inicia Speech de inmediato, transmite parciales a la superposición y llama a `VoiceWakeForwarder` al soltar.
- Cuando inicia pulsar para hablar, pausamos el runtime de palabra de activación para evitar capturas de audio en conflicto; se reinicia automáticamente tras soltar.
- Permisos: requiere Micrófono + Speech; para ver eventos se necesita aprobación de Accesibilidad/Monitoreo de entrada.
- Teclados externos: algunos pueden no exponer Opción derecha como se espera—ofrezca un atajo alternativo si los usuarios reportan fallos.

## Ajustes orientados al usuario

- Alternador **Activación por voz**: habilita el runtime de palabra de activación.
- **Mantener Cmd+Fn para hablar**: habilita el monitor de pulsar para hablar. Deshabilitado en macOS < 26.
- Selectores de idioma y micrófono, medidor de nivel en vivo, tabla de palabras de activación, probador (solo local; no reenvía).
- El selector de micrófono conserva la última selección si un dispositivo se desconecta, muestra una indicación de desconectado y vuelve temporalmente al predeterminado del sistema hasta que regrese.
- **Sonidos**: avisos al detectar activador y al enviar; de forma predeterminada, el sonido del sistema macOS “Glass”. Puede elegir cualquier archivo cargable por `NSSound` (p. ej., MP3/WAV/AIFF) para cada evento o elegir **Sin sonido**.

## Comportamiento de reenvío

- Cuando Activación por voz está habilitada, las transcripciones se reenvían al gateway/agente activo (el mismo modo local vs remoto que usa el resto de la app para mac).
- Las respuestas se entregan al **proveedor principal usado por última vez** (WhatsApp/Telegram/Discord/WebChat). Si la entrega falla, el error se registra y la ejecución sigue siendo visible mediante WebChat/registros de sesión.

## Carga útil de reenvío

- `VoiceWakeForwarder.prefixedTranscript(_:)` antepone la pista de la máquina antes de enviar. Compartido entre las rutas de palabra de activación y pulsar para hablar.

## Verificación rápida

- Active pulsar para hablar, mantenga Cmd+Fn, hable, suelte: la superposición debería mostrar parciales y luego enviar.
- Mientras mantiene presionado, las “orejas” de la barra de menús deben permanecer ampliadas (usa `triggerVoiceEars(ttl:nil)`); se reducen tras soltar.
