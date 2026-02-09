---
summary: "Poda de sesiones: recorte de resultados de herramientas para reducir la hinchazón del contexto"
read_when:
  - Quiere reducir el crecimiento del contexto del LLM a partir de las salidas de herramientas
  - Está ajustando agents.defaults.contextPruning
---

# Poda de sesiones

La poda de sesiones recorta **resultados antiguos de herramientas** del contexto en memoria justo antes de cada llamada al LLM. **No** reescribe el historial de la sesión en disco (`*.jsonl`).

## Cuándo se ejecuta

- Cuando `mode: "cache-ttl"` está habilitado y la última llamada a Anthropic para la sesión es anterior a `ttl`.
- Solo afecta a los mensajes enviados al modelo para esa solicitud.
- Solo está activa para llamadas a la API de Anthropic (y modelos Anthropic de OpenRouter).
- Para obtener mejores resultados, haga coincidir `ttl` con el `cacheControlTtl` de su modelo.
- Después de una poda, la ventana de TTL se restablece, por lo que las solicitudes posteriores mantienen la caché hasta que `ttl` vuelva a expirar.

## Valores predeterminados inteligentes (Anthropic)

- Perfiles de **OAuth o setup-token**: habilitan la poda `cache-ttl` y establecen el latido en `1h`.
- Perfiles de **clave de API**: habilitan la poda `cache-ttl`, establecen el latido en `30m` y establecen `cacheControlTtl` de forma predeterminada en `1h` para modelos Anthropic.
- Si establece explícitamente cualquiera de estos valores, OpenClaw **no** los sobrescribe.

## Qué mejora (costo + comportamiento de la caché)

- **Por qué podar:** la caché de prompts de Anthropic solo se aplica dentro del TTL. Si una sesión queda inactiva más allá del TTL, la siguiente solicitud vuelve a cachear el prompt completo a menos que lo recorte primero.
- **Qué se vuelve más barato:** la poda reduce el tamaño de **cacheWrite** para esa primera solicitud después de que expira el TTL.
- **Por qué importa el restablecimiento del TTL:** una vez que se ejecuta la poda, la ventana de caché se restablece, de modo que las solicitudes posteriores pueden reutilizar el prompt recién cacheado en lugar de volver a cachear todo el historial.
- **Lo que no hace:** la poda no agrega tokens ni “duplica” costos; solo cambia lo que se cachea en esa primera solicitud posterior al TTL.

## Qué se puede podar

- Solo mensajes `toolResult`.
- Los mensajes de usuario + asistente **nunca** se modifican.
- Los últimos `keepLastAssistants` mensajes del asistente están protegidos; los resultados de herramientas posteriores a ese corte no se podan.
- Si no hay suficientes mensajes del asistente para establecer el corte, se omite la poda.
- Los resultados de herramientas que contienen **bloques de imagen** se omiten (nunca se recortan ni se limpian).

## Estimación de la ventana de contexto

La poda usa una ventana de contexto estimada (caracteres ≈ tokens × 4). La ventana base se resuelve en este orden:

1. Anulación `models.providers.*.models[].contextWindow`.
2. Definición del modelo `contextWindow` (del registro de modelos).
3. Valor predeterminado de `200000` tokens.

Si se establece `agents.defaults.contextTokens`, se trata como un límite (mínimo) sobre la ventana resuelta.

## Modo

### cache-ttl

- La poda solo se ejecuta si la última llamada a Anthropic es anterior a `ttl` (predeterminado `5m`).
- Cuando se ejecuta: el mismo comportamiento de recorte suave + limpieza dura que antes.

## Poda suave vs. dura

- **Recorte suave**: solo para resultados de herramientas sobredimensionados.
  - Conserva inicio + final, inserta `...` y agrega una nota con el tamaño original.
  - Omite resultados con bloques de imagen.
- **Limpieza dura**: reemplaza todo el resultado de la herramienta con `hardClear.placeholder`.

## Selección de herramientas

- `tools.allow` / `tools.deny` admiten comodines `*`.
- Rechazar gana.
- La coincidencia no distingue mayúsculas/minúsculas.
- Lista de permitidos vacía => todas las herramientas permitidas.

## Interacción con otros límites

- Las herramientas integradas ya truncan su propia salida; la poda de sesiones es una capa adicional que evita que los chats de larga duración acumulen demasiada salida de herramientas en el contexto del modelo.
- La compactación es independiente: la compactación resume y persiste, la poda es transitoria por solicitud. Consulte [/concepts/compaction](/concepts/compaction).

## Valores predeterminados (cuando está habilitada)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Ejemplos

Predeterminado (desactivado):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Habilitar poda con reconocimiento de TTL:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Restringir la poda a herramientas específicas:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Ver referencia de configuración: [Gateway Configuration](/gateway/configuration)
