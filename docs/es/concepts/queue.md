---
summary: "Diseño de la cola de comandos que serializa ejecuciones de auto-respuesta entrantes"
read_when:
  - Al cambiar la ejecución o la concurrencia de la auto-respuesta
title: "Cola de comandos"
---

# Cola de comandos (2026-01-16)

Serializamos las ejecuciones de auto-respuesta entrantes (todos los canales) mediante una pequeña cola en proceso para evitar que múltiples ejecuciones del agente colisionen, permitiendo a la vez un paralelismo seguro entre sesiones.

## Por qué

- Las ejecuciones de auto-respuesta pueden ser costosas (llamadas al LLM) y pueden colisionar cuando llegan múltiples mensajes entrantes con poca separación temporal.
- La serialización evita competir por recursos compartidos (archivos de sesión, registros, stdin de la CLI) y reduce la probabilidad de límites de tasa aguas arriba.

## Cómo funciona

- Una cola FIFO consciente de carriles drena cada carril con un límite de concurrencia configurable (predeterminado 1 para carriles no configurados; main predetermina 4, subagent 8).
- `runEmbeddedPiAgent` encola por **clave de sesión** (carril `session:<key>`) para garantizar solo una ejecución activa por sesión.
- Cada ejecución de sesión se encola luego en un **carril global** (`main` por defecto) para que el paralelismo total quede limitado por `agents.defaults.maxConcurrent`.
- Cuando el registro detallado está habilitado, las ejecuciones en cola emiten un aviso breve si esperaron más de ~2 s antes de iniciar.
- Los indicadores de escritura se activan de inmediato al encolar (cuando el canal lo admite), de modo que la experiencia del usuario no cambia mientras esperamos nuestro turno.

## Modos de cola (por canal)

Los mensajes entrantes pueden dirigir la ejecución actual, esperar a un turno de seguimiento, o hacer ambas cosas:

- `steer`: inyecta de inmediato en la ejecución actual (cancela llamadas a herramientas pendientes después del siguiente límite de herramienta). Si no hay streaming, recurre a seguimiento.
- `followup`: encola para el siguiente turno del agente después de que termine la ejecución actual.
- `collect`: fusiona todos los mensajes en cola en **un solo** turno de seguimiento (predeterminado). Si los mensajes apuntan a diferentes canales/hilos, se drenan de forma individual para preservar el enrutamiento.
- `steer-backlog` (también conocido como `steer+backlog`): dirige ahora **y** preserva el mensaje para un turno de seguimiento.
- `interrupt` (legado): aborta la ejecución activa de esa sesión y luego ejecuta el mensaje más reciente.
- `queue` (alias legado): igual que `steer`.

Steer-backlog significa que puede obtener una respuesta de seguimiento después de la ejecución dirigida, por lo que
las superficies con streaming pueden parecer duplicadas. Prefiera `collect`/`steer` si desea
una respuesta por mensaje entrante.
Envíe `/queue collect` como comando independiente (por sesión) o establezca `messages.queue.byChannel.discord: "collect"`.

Valores predeterminados (cuando no se establecen en la configuración):

- Todas las superficies → `collect`

Configure de forma global o por canal mediante `messages.queue`:

```json5
{
  messages: {
    queue: {
      mode: "collect",
      debounceMs: 1000,
      cap: 20,
      drop: "summarize",
      byChannel: { discord: "collect" },
    },
  },
}
```

## Opciones de la cola

Las opciones se aplican a `followup`, `collect` y `steer-backlog` (y a `steer` cuando recurre a seguimiento):

- `debounceMs`: esperar silencio antes de iniciar un turno de seguimiento (evita “continúa, continúa”).
- `cap`: máximo de mensajes en cola por sesión.
- `drop`: política de desbordamiento (`old`, `new`, `summarize`).

Resumir conserva una breve lista con viñetas de los mensajes descartados y la inyecta como un prompt de seguimiento sintético.
Valores predeterminados: `debounceMs: 1000`, `cap: 20`, `drop: summarize`.

## Anulaciones por sesión

- Envíe `/queue <mode>` como comando independiente para almacenar el modo de la sesión actual.
- Las opciones se pueden combinar: `/queue collect debounce:2s cap:25 drop:summarize`
- `/queue default` o `/queue reset` limpia la anulación de la sesión.

## Alcance y garantías

- Se aplica a ejecuciones del agente de auto-respuesta en todos los canales entrantes que usan el pipeline de respuesta del gateway (WhatsApp web, Telegram, Slack, Discord, Signal, iMessage, webchat, etc.).
- El carril predeterminado (`main`) es de todo el proceso para entrantes + latidos principales; establezca `agents.defaults.maxConcurrent` para permitir múltiples sesiones en paralelo.
- Pueden existir carriles adicionales (p. ej., `cron`, `subagent`) para que los trabajos en segundo plano se ejecuten en paralelo sin bloquear las respuestas entrantes.
- Los carriles por sesión garantizan que solo una ejecución del agente toque una sesión dada a la vez.
- Sin dependencias externas ni hilos de trabajo en segundo plano; TypeScript puro + promesas.

## Solución de problemas

- Si los comandos parecen atascados, habilite los registros detallados y busque líneas “queued for …ms” para confirmar que la cola se está drenando.
- Si necesita la profundidad de la cola, habilite los registros detallados y observe las líneas de temporización de la cola.
