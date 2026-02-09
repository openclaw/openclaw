---
summary: "Guía para elegir entre heartbeat y trabajos cron para la automatización"
read_when:
  - Decidir cómo programar tareas recurrentes
  - Configurar monitoreo en segundo plano o notificaciones
  - Optimizar el uso de tokens para verificaciones periódicas
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Cuándo usar cada uno

Tanto los heartbeats como los trabajos cron le permiten ejecutar tareas según un horario. Esta guía le ayuda a elegir el mecanismo adecuado para su caso de uso.

## Guía rápida de decisión

| Caso de uso                                                         | Recomendado                                 | Por qué                                                  |
| ------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| Revisar la bandeja cada 30 min                                      | Heartbeat                                   | Agrupa con otras verificaciones, consciente del contexto |
| Enviar informe diario a las 9 a. m. | Cron (aislado)           | Se necesita temporización exacta                         |
| Monitorear calendario de eventos                                    | Heartbeat                                   | Encaje natural para conciencia periódica                 |
| Ejecutar análisis profundo semanal                                  | Cron (aislado)           | Tarea independiente, puede usar otro modelo              |
| Recuérdeme en 20 minutos                                            | Cron (principal, `--at`) | Única ejecución con temporización precisa                |
| Verificación de salud de proyecto en segundo plano                  | Heartbeat                                   | Aprovecha el ciclo existente                             |

## Heartbeat: Conciencia periódica

Los heartbeats se ejecutan en la **sesión principal** a un intervalo regular (predeterminado: 30 min). Están diseñados para que el agente revise el estado y destaque cualquier cosa importante.

### Cuándo usar heartbeat

- **Múltiples verificaciones periódicas**: En lugar de 5 trabajos cron separados revisando bandeja, calendario, clima, notificaciones y estado del proyecto, un solo heartbeat puede agrupar todo.
- **Decisiones con conciencia de contexto**: El agente tiene el contexto completo de la sesión principal, por lo que puede decidir inteligentemente qué es urgente y qué puede esperar.
- **Continuidad conversacional**: Las ejecuciones de heartbeat comparten la misma sesión, por lo que el agente recuerda conversaciones recientes y puede dar seguimiento de forma natural.
- **Monitoreo de bajo overhead**: Un heartbeat reemplaza muchas tareas pequeñas de sondeo.

### Ventajas de heartbeat

- **Agrupa múltiples verificaciones**: Un turno del agente puede revisar bandeja, calendario y notificaciones a la vez.
- **Reduce llamadas a la API**: Un solo heartbeat es más económico que 5 trabajos cron aislados.
- **Consciente del contexto**: El agente sabe en qué ha estado trabajando y puede priorizar en consecuencia.
- **Supresión inteligente**: Si no se requiere atención, el agente responde `HEARTBEAT_OK` y no se entrega ningún mensaje.
- **Temporización natural**: Se desvía ligeramente según la carga de la cola, lo cual es aceptable para la mayoría del monitoreo.

### Ejemplo de heartbeat: checklist de HEARTBEAT.md

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

El agente lee esto en cada heartbeat y gestiona todos los elementos en un solo turno.

### Configurar heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Vea [Heartbeat](/gateway/heartbeat) para la configuración completa.

## Cron: Programación precisa

Los trabajos cron se ejecutan en **horarios exactos** y pueden ejecutarse en sesiones aisladas sin afectar el contexto principal.

### Cuándo usar cron

- **Se requiere temporización exacta**: "Enviar esto a las 9:00 a. m. todos los lunes" (no "alrededor de las 9").
- **Tareas independientes**: Tareas que no necesitan contexto conversacional.
- **Modelo/pensamiento diferente**: Análisis pesado que amerita un modelo más potente.
- **Recordatorios de una sola vez**: "Recuérdeme en 20 minutos" con `--at`.
- **Tareas ruidosas/frecuentes**: Tareas que saturarían el historial de la sesión principal.
- **Disparadores externos**: Tareas que deben ejecutarse independientemente de si el agente está activo.

### Ventajas de cron

- **Temporización exacta**: Expresiones cron de 5 campos con soporte de zona horaria.
- **Aislamiento de sesión**: Se ejecuta en `cron:<jobId>` sin contaminar el historial principal.
- **Anulación de modelo**: Use un modelo más económico o más potente por trabajo.
- **Control de entrega**: Los trabajos aislados usan por defecto `announce` (resumen); elija `none` según sea necesario.
- **Entrega inmediata**: El modo de anuncio publica directamente sin esperar al heartbeat.
- **No requiere contexto del agente**: Se ejecuta incluso si la sesión principal está inactiva o compactada.
- **Soporte de una sola ejecución**: `--at` para marcas de tiempo futuras precisas.

### Ejemplo de cron: Informe matutino diario

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Esto se ejecuta exactamente a las 7:00 a. m. hora de Nueva York, usa Opus para mayor calidad y anuncia un resumen directamente a WhatsApp.

### Ejemplo de cron: Recordatorio de una sola vez

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Vea [Cron jobs](/automation/cron-jobs) para la referencia completa de la CLI.

## Diagrama de flujo de decisión

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Combinando ambos

La configuración más eficiente usa **ambos**:

1. **Heartbeat** gestiona el monitoreo rutinario (bandeja, calendario, notificaciones) en un turno agrupado cada 30 minutos.
2. **Cron** gestiona horarios precisos (informes diarios, revisiones semanales) y recordatorios de una sola vez.

### Ejemplo: Configuración de automatización eficiente

**HEARTBEAT.md** (verificado cada 30 min):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Trabajos cron** (temporización precisa):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Flujos de trabajo deterministas con aprobaciones

Lobster es el runtime de flujos de trabajo para **pipelines de herramientas de varios pasos** que requieren ejecución determinista y aprobaciones explícitas.
Úselo cuando la tarea sea más que un solo turno del agente y quiera un flujo reanudable con puntos de control humanos.

### Cuándo encaja Lobster

- **Automatización de varios pasos**: Necesita un pipeline fijo de llamadas a herramientas, no un prompt puntual.
- **Puertas de aprobación**: Los efectos secundarios deben pausarse hasta que usted apruebe y luego reanudar.
- **Ejecuciones reanudables**: Continúe un flujo pausado sin volver a ejecutar pasos anteriores.

### Cómo se integra con heartbeat y cron

- **Heartbeat/cron** deciden _cuándo_ ocurre una ejecución.
- **Lobster** define _qué pasos_ ocurren una vez que inicia la ejecución.

Para flujos programados, use cron o heartbeat para disparar un turno del agente que llame a Lobster.
Para flujos ad-hoc, llame a Lobster directamente.

### Notas operativas (del código)

- Lobster se ejecuta como un **subproceso local** (CLI `lobster`) en modo herramienta y devuelve un **sobre JSON**.
- Si la herramienta devuelve `needs_approval`, usted reanuda con un `resumeToken` y la bandera `approve`.
- La herramienta es un **plugin opcional**; habilítelo de forma aditiva mediante `tools.alsoAllow: ["lobster"]` (recomendado).
- Si pasa `lobsterPath`, debe ser una **ruta absoluta**.

Vea [Lobster](/tools/lobster) para uso completo y ejemplos.

## Sesión principal vs sesión aislada

Tanto heartbeat como cron pueden interactuar con la sesión principal, pero de manera diferente:

|           | Heartbeat                         | Cron (principal)                   | Cron (aislado)                    |
| --------- | --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Sesión    | Principal                         | Principal (vía evento del sistema) | `cron:<jobId>`                                       |
| Historial | Compartido                        | Compartido                                            | Nuevo en cada ejecución                              |
| Contexto  | Completo                          | Completo                                              | Ninguno (comienza limpio)         |
| Modelo    | Modelo de la sesión principal     | Modelo de la sesión principal                         | Se puede anular                                      |
| Salida    | Entregada si no es `HEARTBEAT_OK` | Prompt de heartbeat + evento                          | Anunciar resumen (predeterminado) |

### Cuándo usar cron en sesión principal

Use `--session main` con `--system-event` cuando quiera:

- Que el recordatorio/evento aparezca en el contexto de la sesión principal
- Que el agente lo gestione durante el próximo heartbeat con contexto completo
- No tener una ejecución aislada separada

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Cuándo usar cron aislado

Use `--session isolated` cuando quiera:

- Una pizarra limpia sin contexto previo
- Configuraciones de modelo o pensamiento diferentes
- Anunciar resúmenes directamente a un canal
- Un historial que no sature la sesión principal

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Consideraciones de costos

| Mecanismo                           | Perfil de costos                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Heartbeat                           | Un turno cada N minutos; escala con el tamaño de HEARTBEAT.md |
| Cron (principal) | Agrega un evento al próximo heartbeat (sin turno aislado)  |
| Cron (aislado)   | Un turno completo del agente por trabajo; puede usar un modelo más económico  |

**Consejos**:

- Mantenga `HEARTBEAT.md` pequeño para minimizar el overhead de tokens.
- Agrupe verificaciones similares en heartbeat en lugar de múltiples trabajos cron.
- Use `target: "none"` en heartbeat si solo desea procesamiento interno.
- Use cron aislado con un modelo más económico para tareas rutinarias.

## Relacionado

- [Heartbeat](/gateway/heartbeat) - configuración completa de heartbeat
- [Cron jobs](/automation/cron-jobs) - referencia completa de la CLI y la API de cron
- [System](/cli/system) - eventos del sistema + controles de heartbeat
