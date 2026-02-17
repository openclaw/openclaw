---
summary: "Modos de voice wake y push-to-talk más detalles de enrutamiento en la app de Mac"
read_when:
  - Trabajando en rutas de voice wake o PTT
title: "Voice Wake"
---

# Voice Wake y Push-to-Talk

## Modos

- **Modo Wake-word** (predeterminado): el reconocedor de Speech siempre activo espera tokens de activación (`swabbleTriggerWords`). Al coincidir inicia captura, muestra la superposición con texto parcial, y auto-envía después del silencio.
- **Push-to-talk (mantener Option derecha)**: mantén la tecla Option derecha para capturar inmediatamente—no se necesita activador. La superposición aparece mientras se mantiene; al soltar finaliza y reenvía después de un breve retraso para que puedas ajustar el texto.

## Comportamiento en tiempo de ejecución (wake-word)

- El reconocedor de Speech vive en `VoiceWakeRuntime`.
- El activador solo dispara cuando hay una **pausa significativa** entre la palabra de activación y la siguiente palabra (~0.55s de espacio). La superposición/chime puede iniciarse en la pausa incluso antes de que comience el comando.
- Ventanas de silencio: 2.0s cuando el habla está fluyendo, 5.0s si solo se escuchó el activador.
- Parada dura: 120s para prevenir sesiones desbocadas.
- Debounce entre sesiones: 350ms.
- La superposición se maneja vía `VoiceWakeOverlayController` con coloración comprometida/volátil.
- Después de enviar, el reconocedor se reinicia limpiamente para escuchar el siguiente activador.

## Invariantes del ciclo de vida

- Si Voice Wake está habilitado y los permisos están otorgados, el reconocedor de wake-word debe estar escuchando (excepto durante una captura explícita de push-to-talk).
- La visibilidad de la superposición (incluyendo descarte manual vía el botón X) nunca debe prevenir que el reconocedor se reanude.

## Modo de fallo de superposición pegajosa (previo)

Previamente, si la superposición quedaba atascada visible y la cerrabas manualmente, Voice Wake podía aparecer "muerto" porque el intento de reinicio del runtime podía ser bloqueado por la visibilidad de la superposición y no se programaba ningún reinicio subsiguiente.

Endurecimiento:

- El reinicio del runtime de wake ya no es bloqueado por la visibilidad de la superposición.
- La finalización del descarte de superposición dispara un `VoiceWakeRuntime.refresh(...)` vía `VoiceSessionCoordinator`, así que el X-dismiss manual siempre reanuda la escucha.

## Especificaciones de push-to-talk

- La detección de tecla de acceso rápido usa un monitor global `.flagsChanged` para **Option derecha** (`keyCode 61` + `.option`). Solo observamos eventos (sin tragado).
- El pipeline de captura vive en `VoicePushToTalk`: inicia Speech inmediatamente, transmite parciales a la superposición, y llama a `VoiceWakeForwarder` al soltar.
- Cuando push-to-talk inicia pausamos el runtime de wake-word para evitar tomas de audio en duelo; se reinicia automáticamente después de soltar.
- Permisos: requiere Microphone + Speech; ver eventos necesita aprobación de Accessibility/Input Monitoring.
- Teclados externos: algunos pueden no exponer Option derecha como se espera—ofrece un atajo de respaldo si los usuarios reportan fallos.

## Configuraciones de cara al usuario

- **Toggle Voice Wake**: habilita el runtime de wake-word.
- **Hold Cmd+Fn to talk**: habilita el monitor de push-to-talk. Deshabilitado en macOS < 26.
- Selectores de idioma y micrófono, medidor de nivel en vivo, tabla de palabras activadoras, tester (solo local; no reenvía).
- El selector de micrófono preserva la última selección si un dispositivo se desconecta, muestra una pista de desconectado, y temporalmente recurre al predeterminado del sistema hasta que regrese.
- **Sounds**: chimes al detectar activador y al enviar; por defecto es el sonido del sistema "Glass" de macOS. Puedes elegir cualquier archivo cargable por `NSSound` (ej. MP3/WAV/AIFF) para cada evento o elegir **No Sound**.

## Comportamiento de reenvío

- Cuando Voice Wake está habilitado, las transcripciones se reenvían al gateway/agente activo (el mismo modo local vs remoto usado por el resto de la app de Mac).
- Las respuestas se entregan al **proveedor principal usado por última vez** (WhatsApp/Telegram/Discord/WebChat). Si la entrega falla, el error se registra y la ejecución sigue visible vía WebChat/logs de sesión.

## Payload de reenvío

- `VoiceWakeForwarder.prefixedTranscript(_:)` antepone la pista de máquina antes de enviar. Compartido entre rutas de wake-word y push-to-talk.

## Verificación rápida

- Activa push-to-talk, mantén Cmd+Fn, habla, suelta: la superposición debe mostrar parciales luego enviar.
- Mientras mantienes, las orejas de la barra de menú deben permanecer agrandadas (usa `triggerVoiceEars(ttl:nil)`); caen después de soltar.
