---
summary: "Cómo OpenClaw construye el contexto del prompt y reporta el uso de tokens y los costos"
read_when:
  - Al explicar el uso de tokens, costos o ventanas de contexto
  - Al depurar el crecimiento del contexto o el comportamiento de compactación
title: "Uso de tokens y costos"
---

# Uso de tokens y costos

OpenClaw realiza el seguimiento de **tokens**, no de caracteres. Los tokens son específicos del modelo, pero la mayoría de los modelos de estilo OpenAI promedian ~4 caracteres por token para texto en inglés.

## Cómo se construye el prompt del sistema

OpenClaw ensambla su propio prompt del sistema en cada ejecución. Incluye:

- Lista de herramientas + descripciones breves
- Lista de Skills (solo metadatos; las instrucciones se cargan bajo demanda con `read`)
- Instrucciones de autoactualización
- Espacio de trabajo + archivos de arranque (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` cuando son nuevos). Los archivos grandes se truncan mediante `agents.defaults.bootstrapMaxChars` (predeterminado: 20000).
- Hora (UTC + zona horaria del usuario)
- Etiquetas de respuesta + comportamiento de heartbeat
- Metadatos de tiempo de ejecución (host/OS/model/thinking)

Vea el desglose completo en [System Prompt](/concepts/system-prompt).

## Qué cuenta dentro de la ventana de contexto

Todo lo que recibe el modelo cuenta para el límite de contexto:

- Prompt del sistema (todas las secciones listadas arriba)
- Historial de la conversación (mensajes del usuario + asistente)
- Llamadas a herramientas y resultados de herramientas
- Adjuntos/transcripciones (imágenes, audio, archivos)
- Resúmenes de compactación y artefactos de poda
- Envoltorios del proveedor o encabezados de seguridad (no visibles, pero igualmente contados)

Para un desglose práctico (por archivo inyectado, herramientas, skills y tamaño del prompt del sistema), use `/context list` o `/context detail`. Consulte [Context](/concepts/context).

## Cómo ver el uso actual de tokens

Use estos comandos en el chat:

- `/status` → **tarjeta de estado rica en emojis** con el modelo de la sesión, uso del contexto,
  tokens de entrada/salida de la última respuesta y **costo estimado** (solo con clave de API).
- `/usage off|tokens|full` → agrega un **pie de uso por respuesta** a cada respuesta.
  - Persiste por sesión (almacenado como `responseUsage`).
  - La autenticación OAuth **oculta el costo** (solo tokens).
- `/usage cost` → muestra un resumen local de costos a partir de los registros de sesión de OpenClaw.

Otras superficies:

- **TUI/Web TUI:** se admiten `/status` + `/usage`.
- **CLI:** `openclaw status --usage` y `openclaw channels list` muestran
  ventanas de cuota del proveedor (no costos por respuesta).

## Estimación de costos (cuando se muestra)

Los costos se estiman a partir de la configuración de precios de su modelo:

```
models.providers.<provider>.models[].cost
```

Estos son **USD por 1M de tokens** para `input`, `output`, `cacheRead` y
`cacheWrite`. Si faltan precios, OpenClaw muestra solo los tokens. Los tokens OAuth
nunca muestran el costo en dólares.

## TTL de caché e impacto de la poda

El almacenamiento en caché de prompts del proveedor solo se aplica dentro de la ventana de TTL de la caché. OpenClaw puede
ejecutar opcionalmente **poda por cache-ttl**: poda la sesión una vez que el TTL de la caché
ha expirado y luego reinicia la ventana de caché para que las solicitudes posteriores puedan reutilizar el
contexto recién almacenado en caché en lugar de volver a almacenar en caché todo el historial. Esto mantiene
más bajos los costos de escritura de caché cuando una sesión queda inactiva más allá del TTL.

Configúrelo en [Gateway configuration](/gateway/configuration) y consulte los
detalles de comportamiento en [Session pruning](/concepts/session-pruning).

El heartbeat puede mantener la caché **caliente** a través de períodos de inactividad. Si el TTL de caché de su modelo
es `1h`, configurar el intervalo de heartbeat justo por debajo de ese valor (por ejemplo, `55m`) puede evitar
volver a almacenar en caché el prompt completo, reduciendo los costos de escritura de caché.

Para los precios de la API de Anthropic, las lecturas de caché son significativamente más baratas que los tokens de entrada,
mientras que las escrituras de caché se facturan con un multiplicador más alto. Consulte los precios de almacenamiento en caché de prompts de Anthropic para conocer las tarifas y multiplicadores de TTL más recientes:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Ejemplo: mantener caliente una caché de 1 h con heartbeat

```yaml
agents:
  defaults:
    model:
      primary: "anthropic/claude-opus-4-6"
    models:
      "anthropic/claude-opus-4-6":
        params:
          cacheRetention: "long"
    heartbeat:
      every: "55m"
```

## Consejos para reducir la presión de tokens

- Use `/compact` para resumir sesiones largas.
- Recorte salidas grandes de herramientas en sus flujos de trabajo.
- Mantenga cortas las descripciones de skills (la lista de skills se inyecta en el prompt).
- Prefiera modelos más pequeños para trabajo exploratorio y verboso.

Consulte [Skills](/tools/skills) para conocer la fórmula exacta de sobrecarga de la lista de skills.
