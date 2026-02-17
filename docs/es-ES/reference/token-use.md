---
summary: "Cómo OpenClaw construye el contexto del prompt y reporta uso de tokens + costos"
read_when:
  - Explicando uso de tokens, costos o ventanas de contexto
  - Depurando crecimiento de contexto o comportamiento de compactación
title: "Uso de Tokens y Costos"
---

# Uso de tokens y costos

OpenClaw rastrea **tokens**, no caracteres. Los tokens son específicos del modelo, pero la mayoría de los modelos estilo OpenAI promedian ~4 caracteres por token para texto en inglés.

## Cómo se construye el prompt del sistema

OpenClaw ensambla su propio prompt de sistema en cada ejecución. Incluye:

- Lista de herramientas + descripciones cortas
- Lista de habilidades (solo metadatos; las instrucciones se cargan bajo demanda con `read`)
- Instrucciones de auto-actualización
- Archivos de espacio de trabajo + bootstrap (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md` cuando es nuevo, más `MEMORY.md` y/o `memory.md` cuando están presentes). Los archivos grandes se truncan por `agents.defaults.bootstrapMaxChars` (predeterminado: 20000), y la inyección total de bootstrap está limitada por `agents.defaults.bootstrapTotalMaxChars` (predeterminado: 150000). Los archivos `memory/*.md` se cargan bajo demanda a través de herramientas de memoria y no se auto-inyectan.
- Hora (UTC + zona horaria del usuario)
- Etiquetas de respuesta + comportamiento de latidos
- Metadatos de tiempo de ejecución (host/OS/modelo/pensamiento)

Ver el desglose completo en [Prompt del Sistema](/es-ES/concepts/system-prompt).

## Qué cuenta en la ventana de contexto

Todo lo que recibe el modelo cuenta para el límite de contexto:

- Prompt del sistema (todas las secciones listadas arriba)
- Historial de conversación (mensajes de usuario + asistente)
- Llamadas de herramientas y resultados de herramientas
- Adjuntos/transcripciones (imágenes, audio, archivos)
- Resúmenes de compactación y artefactos de poda
- Envoltorios de proveedor o encabezados de seguridad (no visibles, pero aún contados)

Para un desglose práctico (por archivo inyectado, herramientas, habilidades y tamaño del prompt del sistema), usa `/context list` o `/context detail`. Ver [Contexto](/es-ES/concepts/context).

## Cómo ver el uso actual de tokens

Usa estos en el chat:

- `/status` → **tarjeta de estado con emojis** con el modelo de sesión, uso de contexto,
  tokens de entrada/salida de la última respuesta, y **costo estimado** (solo clave de API).
- `/usage off|tokens|full` → agrega un **pie de página de uso por respuesta** a cada respuesta.
  - Persiste por sesión (almacenado como `responseUsage`).
  - La autenticación OAuth **oculta el costo** (solo tokens).
- `/usage cost` → muestra un resumen de costo local de los logs de sesión de OpenClaw.

Otras superficies:

- **TUI/Web TUI:** `/status` + `/usage` son soportados.
- **CLI:** `openclaw status --usage` y `openclaw channels list` muestran
  ventanas de cuota del proveedor (no costos por respuesta).

## Estimación de costos (cuando se muestra)

Los costos se estiman desde tu configuración de precios del modelo:

```
models.providers.<provider>.models[].cost
```

Estos son **USD por 1M de tokens** para `input`, `output`, `cacheRead`, y
`cacheWrite`. Si falta el precio, OpenClaw muestra solo tokens. Los tokens OAuth
nunca muestran costo en dólares.

## TTL de caché y impacto de la poda

El almacenamiento en caché de prompts del proveedor solo aplica dentro de la ventana TTL de caché. OpenClaw puede
opcionalmente ejecutar **poda de cache-ttl**: poda la sesión una vez que el TTL de caché
ha expirado, luego reinicia la ventana de caché para que las solicitudes subsecuentes puedan re-usar el
contexto recién cacheado en lugar de re-cachear el historial completo. Esto mantiene los costos
de escritura de caché más bajos cuando una sesión está inactiva más allá del TTL.

Configúralo en [Configuración del Gateway](/es-ES/gateway/configuration) y ve los
detalles del comportamiento en [Poda de sesión](/es-ES/concepts/session-pruning).

El latido puede mantener la caché **caliente** a través de brechas de inactividad. Si el TTL de caché de tu modelo
es `1h`, establecer el intervalo de latidos justo debajo de eso (p. ej., `55m`) puede evitar
re-cachear el prompt completo, reduciendo los costos de escritura de caché.

Para los precios de la API de Anthropic, las lecturas de caché son significativamente más baratas que los tokens de entrada,
mientras que las escrituras de caché se facturan con un multiplicador más alto. Ver los precios de almacenamiento en caché de prompts de Anthropic para las tarifas más recientes y multiplicadores TTL:
[https://docs.anthropic.com/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/docs/build-with-claude/prompt-caching)

### Ejemplo: mantener caché de 1h caliente con latidos

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

- Usa `/compact` para resumir sesiones largas.
- Recorta salidas de herramientas grandes en tus flujos de trabajo.
- Mantén las descripciones de habilidades cortas (la lista de habilidades se inyecta en el prompt).
- Prefiere modelos más pequeños para trabajo exploratorio y verboso.

Ver [Habilidades](/es-ES/tools/skills) para la fórmula exacta de sobrecarga de lista de habilidades.
