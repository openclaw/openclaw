---
title: "Tarea LLM"
description: "Delega subtareas a modelos de lenguaje especializados"
---

## Descripción General

La herramienta `llm-task` permite a los agentes delegar subtareas específicas a modelos de lenguaje especializados. Esto habilita:

- **Delegación de tareas**: Descargar trabajo a modelos especializados
- **Procesamiento paralelo**: Ejecutar múltiples tareas simultáneamente
- **Especialización de modelos**: Usar el mejor modelo para cada tarea
- **Gestión de costos**: Optimizar el uso de modelos para eficiencia de costos

## Uso Básico

```typescript
// Delegar una tarea a un modelo especializado
const result = await llmTask({
  task: "Resumir este artículo en 3 puntos clave",
  context: articleContent,
  model: "gpt-4-turbo",
});

console.log(result.output);
```

## Parámetros

| Parámetro     | Tipo   | Requerido | Descripción                                                |
| ------------- | ------ | --------- | ---------------------------------------------------------- |
| `task`        | string | Sí        | Descripción de la tarea a realizar                         |
| `context`     | string | No        | Contexto o datos para la tarea                             |
| `model`       | string | No        | Modelo específico a usar (por defecto: modelo configurado) |
| `temperature` | number | No        | Creatividad del modelo (0-1)                               |
| `maxTokens`   | number | No        | Máximo de tokens de salida                                 |

## Casos de Uso Comunes

### Resumir Contenido

```typescript
// Resumir un artículo largo
const summary = await llmTask({
  task: "Crear un resumen ejecutivo de este informe",
  context: longReport,
  model: "gpt-4-turbo",
  maxTokens: 500,
});
```

### Análisis de Código

```typescript
// Analizar calidad del código
const analysis = await llmTask({
  task: "Revisar este código en busca de problemas de seguridad y mejores prácticas",
  context: codeSnippet,
  model: "claude-3-opus",
});
```

### Extracción de Datos

```typescript
// Extraer datos estructurados
const extracted = await llmTask({
  task: "Extraer todos los nombres, emails y números de teléfono de este texto",
  context: rawText,
  model: "gpt-4-turbo",
  temperature: 0, // Baja temperatura para consistencia
});
```

### Generación de Contenido

```typescript
// Generar contenido creativo
const content = await llmTask({
  task: "Escribir una descripción de producto atractiva",
  context: productDetails,
  model: "gpt-4-turbo",
  temperature: 0.8, // Alta temperatura para creatividad
});
```

## Procesamiento Paralelo

Ejecuta múltiples tareas simultáneamente:

```typescript
// Procesar múltiples documentos en paralelo
const results = await Promise.all([
  llmTask({
    task: "Resumir documento 1",
    context: doc1,
  }),
  llmTask({
    task: "Resumir documento 2",
    context: doc2,
  }),
  llmTask({
    task: "Resumir documento 3",
    context: doc3,
  }),
]);
```

## Selección de Modelos

Elige el modelo adecuado para tu tarea:

| Modelo            | Mejor Para            | Velocidad | Costo |
| ----------------- | --------------------- | --------- | ----- |
| `gpt-4-turbo`     | Razonamiento complejo | Media     | Alto  |
| `gpt-3.5-turbo`   | Tareas generales      | Rápida    | Bajo  |
| `claude-3-opus`   | Análisis largo        | Lenta     | Alto  |
| `claude-3-sonnet` | Equilibrado           | Media     | Medio |
| `claude-3-haiku`  | Tareas rápidas        | Rápida    | Bajo  |

```typescript
// Usar modelo específico para la tarea
const result = await llmTask({
  task: "Análisis rápido de sentimiento",
  context: tweets,
  model: "gpt-3.5-turbo", // Más rápido y económico
});
```

## Gestión de Costos

Optimiza el uso de modelos para controlar costos:

```typescript
// Usar modelos más baratos para tareas simples
const quickSummary = await llmTask({
  task: "Resumir en una oración",
  context: article,
  model: "gpt-3.5-turbo",
  maxTokens: 50,
});

// Reservar modelos caros para tareas complejas
const deepAnalysis = await llmTask({
  task: "Análisis detallado con recomendaciones",
  context: dataSet,
  model: "gpt-4-turbo",
  maxTokens: 2000,
});
```

## Manejo de Errores

```typescript
try {
  const result = await llmTask({
    task: "Analizar estos datos",
    context: data,
  });
} catch (error) {
  if (error.code === "RATE_LIMIT") {
    // Manejar error de límite de tasa
    await sleep(5000);
    // Reintentar...
  } else if (error.code === "INVALID_MODEL") {
    // Recurrir a modelo predeterminado
    const result = await llmTask({
      task: "Analizar estos datos",
      context: data,
      model: "gpt-3.5-turbo",
    });
  }
}
```

## Configuración

```bash
# Establecer modelo predeterminado
openclaw config set llmTask.defaultModel gpt-4-turbo

# Establecer temperatura predeterminada
openclaw config set llmTask.defaultTemperature 0.7

# Establecer límite de tokens predeterminado
openclaw config set llmTask.maxTokens 1000

# Configurar claves API
openclaw config set llmTask.openaiApiKey TU_CLAVE_API
openclaw config set llmTask.anthropicApiKey TU_CLAVE_API
```

## Mejores Prácticas

1. **Tareas claras**: Proporciona descripciones de tareas claras y específicas
2. **Contexto relevante**: Solo incluye contexto necesario para mantener bajos los costos
3. **Modelo apropiado**: Usa el modelo más barato que pueda manejar la tarea
4. **Establecer límites**: Siempre establece maxTokens para controlar costos
5. **Procesamiento paralelo**: Usa Promise.all para tareas independientes
6. **Manejar errores**: Implementa reintentos y estrategias de respaldo

## Ver También

- [Subagentes](/es-ES/tools/subagents) - Crear agentes especializados
- [Thinking](/es-ES/tools/thinking) - Controlar niveles de pensamiento del agente
