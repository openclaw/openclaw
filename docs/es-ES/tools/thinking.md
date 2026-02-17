---
title: Modo de Pensamiento
description: Controlar cuándo y cómo piensa el agente
---

El **Modo de Pensamiento** controla si el agente muestra **razonamiento extendido** o responde directamente.

## Descripción General

Cuando está habilitado, el agente puede usar **pensamiento visible** (razonamiento de cadena de pensamiento) para:

- Resolver problemas complejos paso a paso
- Explicar su razonamiento
- Planificar subtareas

Cuando está deshabilitado, las respuestas son concisas e inmediatas.

## Uso

### CLI

```bash
openclaw agent send --thinking high "Explica cómo funciona este algoritmo"
openclaw agent send --thinking low "¿Cuál es la versión?"
openclaw agent send --thinking off "Respuesta rápida, por favor"
```

### Comandos Slash

En tu `~/.openclaw/slash-commands.json`:

```json
{
  "name": "explain",
  "description": "Explicar código con razonamiento detallado",
  "thinking": "high"
}
```

## Niveles de Pensamiento

| Nivel    | Comportamiento                              |
| -------- | ------------------------------------------- |
| `high`   | Razonamiento extendido visible; paso a paso |
| `medium` | Equilibrado; pensamiento moderado           |
| `low`    | Mínimo razonamiento; respuestas rápidas     |
| `off`    | Sin pensamiento visible; solo salida final  |

## Cuándo Usarlo

✅ **Usa `high` para:**

- Resolución de problemas complejos
- Depuración de tareas multipasos
- Explicación de decisiones de arquitectura

✅ **Usa `low` o `off` para:**

- Respuestas de hechos rápidos
- Comandos simples (como "ejecutar pruebas")
- Salida que va directamente a canales de mensajería

## Configuración Global

Establece un predeterminado para todos los mensajes de agente:

```bash
openclaw config set agent.thinking medium
```

## Nota de Compatibilidad de Modelos

No todos los modelos soportan pensamiento explícito. Si tu modelo no muestra razonamiento incluso cuando `thinking=high`, el modelo puede no tener capacidades de cadena de pensamiento habilitadas.

## Referencias

- [Comandos Slash](/es-ES/tools/slash-commands) – configurar el modo de pensamiento por comando
- [CLI: agent send](/es-ES/tools/agent-send) – invocar agentes con banderas de pensamiento
