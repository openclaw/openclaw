---
summary: "Ciclo de vida de la superposición de voz cuando wake-word y push-to-talk se superponen"
read_when:
  - Ajustando el comportamiento de la superposición de voz
title: "Superposición de Voz"
---

# Ciclo de Vida de la Superposición de Voz (macOS)

Audiencia: contribuidores de la app de macOS. Objetivo: mantener la superposición de voz predecible cuando wake-word y push-to-talk se superponen.

## Intención actual

- Si la superposición ya está visible desde wake-word y el usuario presiona la tecla de acceso rápido, la sesión de tecla de acceso rápido _adopta_ el texto existente en lugar de restablecerlo. La superposición permanece visible mientras se mantiene la tecla de acceso rápido. Cuando el usuario la suelta: envía si hay texto recortado, de lo contrario descarta.
- Wake-word solo todavía auto-envía en silencio; push-to-talk envía inmediatamente al soltar.

## Implementado (9 de diciembre de 2025)

- Las sesiones de superposición ahora llevan un token por captura (wake-word o push-to-talk). Las actualizaciones parciales/finales/enviar/descartar/nivel se descartan cuando el token no coincide, evitando callbacks obsoletos.
- Push-to-talk adopta cualquier texto de superposición visible como prefijo (así que presionar la tecla de acceso rápido mientras la superposición de wake está arriba mantiene el texto y añade nuevo habla). Espera hasta 1.5s para una transcripción final antes de recurrir al texto actual.
- El logging de chime/overlay se emite en `info` en las categorías `voicewake.overlay`, `voicewake.ptt`, y `voicewake.chime` (inicio de sesión, parcial, final, enviar, descartar, razón de chime).

## Próximos pasos

1. **VoiceSessionCoordinator (actor)**
   - Posee exactamente una `VoiceSession` a la vez.
   - API (basada en tokens): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Descarta callbacks que llevan tokens obsoletos (previene que reconocedores antiguos reabran la superposición).
2. **VoiceSession (modelo)**
   - Campos: `token`, `source` (wakeWord|pushToTalk), texto comprometido/volátil, banderas de chime, temporizadores (auto-envío, inactivo), `overlayMode` (display|editing|sending), deadline de cooldown.
3. **Binding de superposición**
   - `VoiceSessionPublisher` (`ObservableObject`) refleja la sesión activa en SwiftUI.
   - `VoiceWakeOverlayView` renderiza solo vía el publicador; nunca muta singletons globales directamente.
   - Las acciones de usuario de superposición (`sendNow`, `dismiss`, `edit`) llaman de vuelta al coordinador con el token de sesión.
4. **Ruta de envío unificada**
   - En `endCapture`: si el texto recortado está vacío → descartar; de lo contrario `performSend(session:)` (reproduce chime de envío una vez, reenvía, descarta).
   - Push-to-talk: sin demora; wake-word: demora opcional para auto-envío.
   - Aplica un cooldown corto al runtime de wake después de que push-to-talk termina para que wake-word no se reactive inmediatamente.
5. **Logging**
   - El coordinador emite logs `.info` en el subsistema `bot.molt`, categorías `voicewake.overlay` y `voicewake.chime`.
   - Eventos clave: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Checklist de depuración

- Stream de logs mientras reproduces una superposición pegajosa:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verifica solo un token de sesión activo; los callbacks obsoletos deben ser descartados por el coordinador.
- Asegúrate de que la liberación de push-to-talk siempre llame a `endCapture` con el token activo; si el texto está vacío, espera `dismiss` sin chime o envío.

## Pasos de migración (sugeridos)

1. Añadir `VoiceSessionCoordinator`, `VoiceSession`, y `VoiceSessionPublisher`.
2. Refactorizar `VoiceWakeRuntime` para crear/actualizar/terminar sesiones en lugar de tocar `VoiceWakeOverlayController` directamente.
3. Refactorizar `VoicePushToTalk` para adoptar sesiones existentes y llamar a `endCapture` al soltar; aplicar cooldown de runtime.
4. Conectar `VoiceWakeOverlayController` al publicador; eliminar llamadas directas desde runtime/PTT.
5. Añadir tests de integración para adopción de sesión, cooldown, y descarte de texto vacío.
