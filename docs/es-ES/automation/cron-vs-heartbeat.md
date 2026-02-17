---
summary: "Orientación para elegir entre heartbeat y tareas programadas para automatización"
read_when:
  - Decidiendo cómo programar tareas recurrentes
  - Configurando monitoreo en segundo plano o notificaciones
  - Optimizando uso de tokens para verificaciones periódicas
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Cuándo usar cada uno

Tanto los heartbeats como las tareas programadas te permiten ejecutar tareas en una programación. Esta guía te ayuda a elegir el mecanismo correcto para tu caso de uso.

## Guía de decisión rápida

| Caso de uso                              | Recomendado         | Por qué                                      |
| ---------------------------------------- | ------------------- | -------------------------------------------- |
| Revisar bandeja de entrada cada 30 min  | Heartbeat           | Agrupa con otras verificaciones, consciente del contexto |
| Enviar informe diario a las 9am exactas  | Cron (aislado)      | Se necesita tiempo exacto                    |
| Monitorear calendario para eventos próximos | Heartbeat        | Encaja naturalmente para conciencia periódica |
| Ejecutar análisis profundo semanal       | Cron (aislado)      | Tarea independiente, puede usar diferente modelo |
| Recuérdame en 20 minutos                 | Cron (main, `--at`) | Una sola vez con tiempo preciso              |
| Verificación de salud de proyecto en segundo plano | Heartbeat | Se aprovecha del ciclo existente    |

## Heartbeat: Conciencia periódica

Los heartbeats se ejecutan en la **sesión principal** en un intervalo regular (por defecto: 30 min). Están diseñados para que el agente verifique cosas y destaque cualquier cosa importante.

### Cuándo usar heartbeat

- **Múltiples verificaciones periódicas**: En lugar de 5 trabajos cron separados verificando bandeja de entrada, calendario, clima, notificaciones y estado de proyecto, un solo heartbeat puede agrupar todo esto.
- **Decisiones conscientes del contexto**: El agente tiene contexto completo de sesión principal, así que puede tomar decisiones inteligentes sobre qué es urgente vs. qué puede esperar.
- **Continuidad conversacional**: Las ejecuciones de heartbeat comparten la misma sesión, así que el agente recuerda conversaciones recientes y puede dar seguimiento naturalmente.
- **Monitoreo de baja sobrecarga**: Un heartbeat reemplaza muchas tareas pequeñas de sondeo.

### Ventajas del heartbeat

- **Agrupa múltiples verificaciones**: Un turno de agente puede revisar bandeja de entrada, calendario y notificaciones juntos.
- **Reduce llamadas API**: Un solo heartbeat es más barato que 5 trabajos cron aislados.
- **Consciente del contexto**: El agente sabe en qué has estado trabajando y puede priorizar en consecuencia.
- **Supresión inteligente**: Si nada necesita atención, el agente responde `HEARTBEAT_OK` y no se entrega ningún mensaje.
- **Tiempo natural**: Se desvía ligeramente basado en la carga de la cola, lo cual está bien para la mayoría del monitoreo.

### Ejemplo de heartbeat: lista de verificación HEARTBEAT.md

```md
# Lista de verificación de heartbeat

- Revisar correo para mensajes urgentes
- Revisar calendario para eventos en próximas 2 horas
- Si una tarea en segundo plano terminó, resumir resultados
- Si inactivo por 8+ horas, enviar un breve chequeo
```

El agente lee esto en cada heartbeat y maneja todos los elementos en un turno.

### Configurar heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // intervalo
        target: "last", // dónde entregar alertas
        activeHours: { start: "08:00", end: "22:00" }, // opcional
      },
    },
  },
}
```

Ver [Heartbeat](/es-ES/gateway/heartbeat) para configuración completa.

## Cron: Programación precisa

Los trabajos cron se ejecutan en **tiempos exactos** y pueden ejecutarse en sesiones aisladas sin afectar el contexto principal.

### Cuándo usar cron

- **Se requiere tiempo exacto**: "Enviar esto a las 9:00 AM cada lunes" (no "en algún momento alrededor de las 9").
- **Tareas independientes**: Tareas que no necesitan contexto conversacional.
- **Diferente modelo/pensamiento**: Análisis pesado que justifica un modelo más potente.
- **Recordatorios de una sola vez**: "Recuérdame en 20 minutos" con `--at`.
- **Tareas ruidosas/frecuentes**: Tareas que desordenarían el historial de sesión principal.
- **Disparadores externos**: Tareas que deben ejecutarse independientemente de si el agente está activo de otra manera.

### Ventajas de cron

- **Tiempo exacto**: Expresiones cron de 5 campos con soporte de zona horaria.
- **Aislamiento de sesión**: Se ejecuta en `cron:<jobId>` sin contaminar el historial principal.
- **Anulaciones de modelo**: Usar un modelo más barato o más potente por trabajo.
- **Control de entrega**: Los trabajos aislados por defecto a `announce` (resumen); elige `none` según sea necesario.
- **Entrega inmediata**: El modo announce publica directamente sin esperar el heartbeat.
- **No se necesita contexto de agente**: Se ejecuta incluso si la sesión principal está inactiva o compactada.
- **Soporte de una sola vez**: `--at` para marcas de tiempo futuras precisas.

### Ejemplo de cron: Briefing matutino diario

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generar briefing de hoy: clima, calendario, principales correos, resumen de noticias." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Esto se ejecuta exactamente a las 7:00 AM hora de Nueva York, usa Opus para calidad, y anuncia un resumen directamente a WhatsApp.

### Ejemplo de cron: Recordatorio de una sola vez

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Recordatorio: la reunión standup comienza en 10 minutos." \
  --wake now \
  --delete-after-run
```

Ver [Tareas programadas](/es-ES/automation/cron-jobs) para referencia completa de CLI.

## Diagrama de flujo de decisión

```
¿La tarea necesita ejecutarse en un tiempo EXACTO?
  SÍ -> Usar cron
  NO  -> Continuar...

¿La tarea necesita aislamiento de la sesión principal?
  SÍ -> Usar cron (aislado)
  NO  -> Continuar...

¿Esta tarea puede agruparse con otras verificaciones periódicas?
  SÍ -> Usar heartbeat (agregar a HEARTBEAT.md)
  NO  -> Usar cron

¿Es esto un recordatorio de una sola vez?
  SÍ -> Usar cron con --at
  NO  -> Continuar...

¿Necesita un modelo o nivel de pensamiento diferente?
  SÍ -> Usar cron (aislado) con --model/--thinking
  NO  -> Usar heartbeat
```

## Combinar ambos

La configuración más eficiente usa **ambos**:

1. **Heartbeat** maneja el monitoreo rutinario (bandeja de entrada, calendario, notificaciones) en un turno agrupado cada 30 minutos.
2. **Cron** maneja programaciones precisas (informes diarios, revisiones semanales) y recordatorios de una sola vez.

### Ejemplo: Configuración de automatización eficiente

**HEARTBEAT.md** (verificado cada 30 min):

```md
# Lista de verificación de heartbeat

- Escanear bandeja de entrada para correos urgentes
- Verificar calendario para eventos en próximas 2h
- Revisar cualquier tarea pendiente
- Chequeo ligero si está en silencio por 8+ horas
```

**Trabajos cron** (tiempo preciso):

```bash
# Briefing matutino diario a las 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Revisión de proyecto semanal los lunes a las 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# Recordatorio de una sola vez
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Devolver llamada al cliente" --wake now
```

## Lobster: Flujos de trabajo determinísticos con aprobaciones

Lobster es el runtime de flujo de trabajo para **pipelines de herramientas de múltiples pasos** que necesitan ejecución determinística y aprobaciones explícitas.
Úsalo cuando la tarea es más que un solo turno de agente, y quieres un flujo de trabajo reanudable con puntos de control humanos.

### Cuándo encaja Lobster

- **Automatización de múltiples pasos**: Necesitas un pipeline fijo de llamadas de herramientas, no un prompt de una sola vez.
- **Puertas de aprobación**: Los efectos secundarios deben pausarse hasta que apruebes, luego resumir.
- **Ejecuciones reanudables**: Continuar un flujo de trabajo pausado sin re-ejecutar pasos anteriores.

### Cómo se empareja con heartbeat y cron

- **Heartbeat/cron** deciden _cuándo_ ocurre una ejecución.
- **Lobster** define _qué pasos_ ocurren una vez que la ejecución comienza.

Para flujos de trabajo programados, usa cron o heartbeat para activar un turno de agente que llama a Lobster.
Para flujos de trabajo ad-hoc, llama a Lobster directamente.

### Notas operacionales (del código)

- Lobster se ejecuta como un **subproceso local** (CLI `lobster`) en modo herramienta y retorna un **sobre JSON**.
- Si la herramienta retorna `needs_approval`, reanudas con un `resumeToken` y flag `approve`.
- La herramienta es un **plugin opcional**; habilítala aditivamente mediante `tools.alsoAllow: ["lobster"]` (recomendado).
- Si pasas `lobsterPath`, debe ser una **ruta absoluta**.

Ver [Lobster](/es-ES/tools/lobster) para uso completo y ejemplos.

## Sesión principal vs Sesión aislada

Tanto heartbeat como cron pueden interactuar con la sesión principal, pero de manera diferente:

|         | Heartbeat                       | Cron (main)              | Cron (aislado)             |
| ------- | ------------------------------- | ------------------------ | -------------------------- |
| Sesión  | Principal                       | Principal (via evento del sistema) | `cron:<jobId>`             |
| Historial | Compartido                    | Compartido               | Nuevo cada ejecución       |
| Contexto | Completo                       | Completo                 | Ninguno (comienza limpio)  |
| Modelo  | Modelo de sesión principal      | Modelo de sesión principal | Puede anular             |
| Salida  | Entregado si no es `HEARTBEAT_OK` | Prompt de heartbeat + evento | Resumen de announce (por defecto) |

### Cuándo usar cron de sesión principal

Usa `--session main` con `--system-event` cuando quieras:

- Que el recordatorio/evento aparezca en el contexto de sesión principal
- Que el agente lo maneje durante el próximo heartbeat con contexto completo
- Sin ejecución aislada separada

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Tiempo para una verificación de salud del proyecto" \
  --wake now
```

### Cuándo usar cron aislado

Usa `--session isolated` cuando quieras:

- Una pizarra limpia sin contexto previo
- Configuraciones de modelo o pensamiento diferentes
- Resúmenes de announce directamente a un canal
- Historial que no desordena la sesión principal

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Análisis semanal de código base..." \
  --model opus \
  --thinking high \
  --announce
```

## Consideraciones de costo

| Mecanismo       | Perfil de costo                                         |
| --------------- | ------------------------------------------------------- |
| Heartbeat       | Un turno cada N minutos; escala con tamaño de HEARTBEAT.md |
| Cron (main)     | Agrega evento al próximo heartbeat (sin turno aislado)  |
| Cron (aislado)  | Turno de agente completo por trabajo; puede usar modelo más barato |

**Consejos**:

- Mantén `HEARTBEAT.md` pequeño para minimizar sobrecarga de tokens.
- Agrupa verificaciones similares en heartbeat en lugar de múltiples trabajos cron.
- Usa `target: "none"` en heartbeat si solo quieres procesamiento interno.
- Usa cron aislado con un modelo más barato para tareas rutinarias.

## Relacionado

- [Heartbeat](/es-ES/gateway/heartbeat) - configuración completa de heartbeat
- [Tareas programadas](/es-ES/automation/cron-jobs) - referencia completa de CLI y API de cron
- [System](/es-ES/cli/system) - eventos del sistema + controles de heartbeat
