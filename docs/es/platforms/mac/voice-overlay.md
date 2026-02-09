---
summary: "Ciclo de vida de la superposición de voz cuando se superponen la palabra de activación y pulsar para hablar"
read_when:
  - Ajustar el comportamiento de la superposición de voz
title: "Superposición de voz"
---

# Ciclo de vida de la superposición de voz (macOS)

Audiencia: colaboradores de la app para macOS. Objetivo: mantener la superposición de voz predecible cuando se superponen la palabra de activación y pulsar para hablar.

## Intención actual

- Si la superposición ya es visible por la palabra de activación y el usuario presiona la tecla rápida, la sesión de la tecla rápida _adopta_ el texto existente en lugar de restablecerlo. La superposición permanece visible mientras se mantiene presionada la tecla. Cuando el usuario suelta: enviar si hay texto recortado; de lo contrario, descartar.
- La palabra de activación por sí sola aún envía automáticamente al detectar silencio; pulsar para hablar envía inmediatamente al soltar.

## Implementado (9 de diciembre de 2025)

- Las sesiones de superposición ahora llevan un token por captura (palabra de activación o pulsar para hablar). Las actualizaciones parciales/finales/enviar/descartar/nivel se descartan cuando el token no coincide, evitando callbacks obsoletos.
- Pulsar para hablar adopta cualquier texto visible de la superposición como prefijo (por lo que presionar la tecla rápida mientras la superposición de palabra de activación está activa conserva el texto y agrega el nuevo discurso). Espera hasta 1.5 s por una transcripción final antes de recurrir al texto actual.
- El registro de timbres/superposición se emite en `info` en las categorías `voicewake.overlay`, `voicewake.ptt` y `voicewake.chime` (inicio de sesión, parcial, final, enviar, descartar, motivo del timbre).

## Siguientes pasos

1. **VoiceSessionCoordinator (actor)**
   - Posee exactamente un `VoiceSession` a la vez.
   - API (basada en tokens): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Descarta callbacks que llevan tokens obsoletos (evita que reconocedores antiguos vuelvan a abrir la superposición).
2. **VoiceSession (modelo)**
   - Campos: `token`, `source` (wakeWord|pushToTalk), texto comprometido/volátil, indicadores de timbre, temporizadores (envío automático, inactividad), `overlayMode` (display|editing|sending), fecha límite de enfriamiento.
3. **Vinculación de la superposición**
   - `VoiceSessionPublisher` (`ObservableObject`) refleja la sesión activa en SwiftUI.
   - `VoiceWakeOverlayView` renderiza solo a través del publicador; nunca muta directamente singletons globales.
   - Las acciones del usuario en la superposición (`sendNow`, `dismiss`, `edit`) llaman de vuelta al coordinador con el token de la sesión.
4. **Ruta de envío unificada**
   - En `endCapture`: si el texto recortado está vacío → descartar; de lo contrario `performSend(session:)` (reproduce el timbre de envío una sola vez, reenvía y descarta).
   - Pulsar para hablar: sin demora; palabra de activación: demora opcional para el envío automático.
   - Aplique un breve enfriamiento al runtime de palabra de activación después de que finalice pulsar para hablar para que la palabra de activación no se dispare inmediatamente.
5. **Registro**
   - El coordinador emite registros `.info` en el subsistema `bot.molt`, categorías `voicewake.overlay` y `voicewake.chime`.
   - Eventos clave: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Lista de verificación de depuración

- Transmita los registros mientras reproduce una superposición pegajosa:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verifique que solo haya un token de sesión activo; el coordinador debe descartar los callbacks obsoletos.

- Asegúrese de que al soltar pulsar para hablar siempre se llame a `endCapture` con el token activo; si el texto está vacío, espere `dismiss` sin timbre ni envío.

## Pasos de migración (sugeridos)

1. Agregue `VoiceSessionCoordinator`, `VoiceSession` y `VoiceSessionPublisher`.
2. Refactorice `VoiceWakeRuntime` para crear/actualizar/finalizar sesiones en lugar de tocar `VoiceWakeOverlayController` directamente.
3. Refactorice `VoicePushToTalk` para adoptar sesiones existentes y llamar a `endCapture` al soltar; aplique enfriamiento en el runtime.
4. Conecte `VoiceWakeOverlayController` al publicador; elimine las llamadas directas desde el runtime/PTT.
5. Agregue pruebas de integración para adopción de sesiones, enfriamiento y descarte con texto vacío.
