---
title: Subagentes
description: Delegar subtareas a agentes especializados
---

Los **Subagentes** permiten que un agente OpenClaw delegue subtareas complejas a agentes especializados y autónomos.

## ¿Por qué Subagentes?

- **Especialización**: Lanza agentes enfocados en exploración de código, documentación o tareas complejas.
- **Paralelización**: Ejecuta múltiples subagentes concurrentemente.
- **Aislamiento de contexto**: Cada subagente comienza fresco; devuelve un resultado conciso de vuelta al padre.

## Uso básico

En una conversación con un agente, puedes usar la herramienta `Task`:

```markdown
**Prompt de ejemplo:**
"Encuentra todos los endpoints de API en este repositorio e investiga cómo funcionan."

El agente puede lanzar un subagente tipo `explore` para buscar en el código.
```

## Tipos de Subagentes

1. **general**: Agente de propósito general para tareas de investigación y ejecución multietapa.
2. **explore**: Agente rápido especializado en explorar bases de código (búsqueda de archivos, búsqueda de contenido, preguntas).

### Agente Explore

Usa `explore` cuando necesites:
- Encontrar archivos rápidamente por patrones
- Buscar código por palabras clave
- Responder preguntas sobre la base de código

**Niveles de minuciosidad**:
- `"quick"` – búsquedas básicas
- `"medium"` – exploración moderada
- `"very thorough"` – análisis exhaustivo a través de múltiples ubicaciones y convenciones de nombres

**Ejemplo:**

```typescript
// El agente padre llama internamente a Task con:
{
  "description": "Buscar endpoints de API",
  "prompt": "Encuentra todos los endpoints de API en src/",
  "subagent_type": "explore",
  "thoroughness": "medium"
}
```

## Cuándo usar Subagentes

✅ **Usar Subagentes para:**
- Tareas de múltiples pasos que requieren autonomía
- Exploración de código cuando no conoces rutas de archivo específicas
- Delegación paralela (múltiples investigaciones a la vez)

❌ **No usar Subagentes para:**
- Leer una ruta de archivo específica (usa `Read` directamente)
- Buscar una clase específica (usa `Glob` directamente)
- Buscar dentro de 2-3 archivos conocidos (usa `Read` directamente)

## Continuación de Sesión

Cada invocación de subagente devuelve un `task_id`. Para continuar una sesión de subagente existente, pasa el mismo `task_id` en lugar de comenzar fresco.

## Mejores Prácticas

1. **Lanzar múltiples subagentes en paralelo** cuando sea posible (llamadas de herramienta múltiples en un solo mensaje).
2. **Proporcionar prompts detallados** – el subagente no ve tu contexto; incluye toda la información relevante.
3. **Especificar qué información devolver** – los subagentes solo envían un mensaje de regreso; diles exactamente qué necesitas.

## Ejemplos de Comandos Slash

Puedes definir [comandos slash](/es-ES/tools/slash-commands) que lancen subagentes:

```json
{
  "name": "analyze-deps",
  "description": "Analizar dependencias del proyecto",
  "task": {
    "subagent_type": "explore",
    "prompt": "Encuentra todos los archivos package.json y enumera las dependencias principales."
  }
}
```

Luego ejecuta:

```
/analyze-deps
```

## Integración de Herramientas

Los subagentes tienen acceso a las mismas herramientas centrales (lectura/escritura de archivos, búsqueda, bash, etc.). Si quieres que un subagente use herramientas personalizadas, habilítalas globalmente o empaquétalas en una [Habilidad](/es-ES/tools/skills).

## Comando de Línea

Puedes invocar subagentes desde la CLI con:

```bash
openclaw agent send --subagent explore "Encuentra todos los archivos TypeScript"
```

Esto crea un contexto de subagente único.

## Detección de Bucles

Los subagentes están sujetos a la misma [detección de bucles](/es-ES/tools/loop-detection) que los agentes padre. Si un subagente repite trabajo inútil, OpenClaw lo detendrá.

## Arquitectura Multi-Agente

Los subagentes son de un solo nivel; no pueden lanzar sus propios subagentes (sin anidamiento). Para orquestación compleja, usa múltiples subagentes de nivel superior en paralelo o secuencialmente.

## Seguridad y Aislamiento

- Los subagentes no ven tu historial de conversación.
- Cada subagente comienza con un contexto vacío más tu prompt.
- Los subagentes no pueden acceder a secretos del padre a menos que los pases explícitamente.

## Depuración

Para ver la comunicación del subagente:

```bash
DEBUG=openclaw:subagent openclaw agent send ...
```

Esto registra el prompt del subagente, la ejecución de herramientas y la respuesta.

## Problemas Comunes

**Problema**: El subagente devuelve resultados incompletos.
**Solución**: Proporciona instrucciones más detalladas en tu prompt; especifica exactamente qué información devolver.

**Problema**: El subagente tarda demasiado.
**Solución**: Reduce el alcance del prompt o usa un nivel de minuciosidad más bajo para el agente explore.

**Problema**: El subagente repite búsquedas.
**Solución**: Proporciona suficiente contexto inicial para evitar ambigüedad.

## Referencias

- [Comandos Slash](/es-ES/tools/slash-commands) – automatizar tareas de subagentes
- [Habilidades](/es-ES/tools/skills) – empaquetar lógica de subagentes reutilizable
- [Detección de Bucles](/es-ES/tools/loop-detection) – cómo OpenClaw previene bucles
- [Herramientas de Sandbox Multi-Agente](/es-ES/tools/multi-agent-sandbox-tools) – patrones de seguridad de sandbox
