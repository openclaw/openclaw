---
summary: "Estados y animaciones del icono de la barra de menús para OpenClaw en macOS"
read_when:
  - Cambiar el comportamiento del icono de la barra de menús
title: "Icono de la barra de menús"
---

# Estados del icono de la barra de menús

Autor: steipete · Actualizado: 2025-12-06 · Alcance: app de macOS (`apps/macos`)

- **Inactivo:** Animación normal del icono (parpadeo, contoneo ocasional).
- **Pausado:** El elemento de estado usa `appearsDisabled`; sin movimiento.
- **Activación por voz (orejas grandes):** El detector de activación por voz llama a `AppState.triggerVoiceEars(ttl: nil)` cuando se escucha la palabra de activación, manteniendo `earBoostActive=true` mientras se captura la emisión. Las orejas se escalan (1.9x), obtienen orificios circulares para mejorar la legibilidad y luego caen mediante `stopVoiceEars()` tras 1 s de silencio. Solo se activa desde la canalización de voz dentro de la app.
- **Trabajando (agente en ejecución):** `AppState.isWorking=true` impulsa una microanimación de “carrera de cola/patas”: mayor contoneo de las patas y un ligero desplazamiento mientras el trabajo está en curso. Actualmente se alterna alrededor de ejecuciones del agente WebChat; agregue el mismo alternado alrededor de otras tareas largas cuando las conecte.

Puntos de conexión

- Activación por voz: el runtime/tester llama a `AppState.triggerVoiceEars(ttl: nil)` al activarse y a `stopVoiceEars()` después de 1 s de silencio para coincidir con la ventana de captura.
- Actividad del agente: establezca `AppStateStore.shared.setWorking(true/false)` alrededor de los intervalos de trabajo (ya hecho en la llamada del agente WebChat). Mantenga los intervalos cortos y restablézcalos en bloques `defer` para evitar animaciones atascadas.

Formas y tamaños

- Icono base dibujado en `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- La escala de orejas tiene como valor predeterminado `1.0`; el refuerzo por voz establece `earScale=1.9` y alterna `earHoles=true` sin cambiar el marco general (imagen plantilla de 18×18 pt renderizada en un respaldo Retina de 36×36 px).
- Scurry usa peluca de pierna de hasta ~1.0 con un pequeño rompecabezas horizontal; es aditivo a cualquier peluca inactiva.

Notas de comportamiento

- No hay alternador externo de CLI/broker para orejas/trabajo; manténgalo interno a las señales propias de la app para evitar aleteos accidentales.
- Mantenga TTLs cortos (&lt;10 s) para que el icono vuelva rápidamente a la línea base si una tarea se queda colgada.
