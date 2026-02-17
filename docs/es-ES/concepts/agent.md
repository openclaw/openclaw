---
title: "Agente"
description: "Entendiendo el sistema de agentes de OpenClaw"
---

# Agente

Un **agente** es una instancia de un modelo de IA que opera de forma autónoma dentro de OpenClaw. Cada agente mantiene su propio contexto, memoria y estado de sesión, lo que le permite manejar tareas complejas y de múltiples pasos a lo largo del tiempo.

## Descripción general

Los agentes en OpenClaw son:

- **Con estado**: Los agentes recuerdan conversaciones pasadas y contexto
- **Autónomos**: Los agentes pueden planificar y ejecutar múltiples pasos sin intervención constante
- **Basados en herramientas**: Los agentes pueden usar herramientas para interactuar con sistemas externos
- **Aislados**: Cada agente opera en su propio espacio de trabajo y sesión

## Anatomía de un agente

Un agente consiste en varios componentes clave:

```
Agent
├── Model (GPT-4, Claude, etc.)
├── Session (historial de conversación)
├── Workspace (directorio de sistema de archivos)
├── Tools (capacidades disponibles)
└── Memory (contexto a largo plazo)
```

### Modelo

El **modelo** es el motor de IA subyacente que alimenta al agente. OpenClaw admite múltiples proveedores de modelos:

- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude)
- Google (Gemini)
- Modelos locales (Ollama, LM Studio)

Configura el modelo predeterminado con:

```bash
openclaw config set model.provider openai
openclaw config set model.name gpt-4-turbo-preview
```

### Sesión

La **sesión** es el historial de conversación entre tú y el agente. Incluye:

- Mensajes del usuario
- Respuestas del agente
- Invocaciones de herramientas
- Resultados de herramientas

Las sesiones persisten entre invocaciones, lo que permite a los agentes mantener contexto a lo largo del tiempo.

### Espacio de trabajo

El **espacio de trabajo** es un directorio dedicado donde el agente puede:

- Leer y escribir archivos
- Ejecutar comandos
- Almacenar datos persistentes

Cada agente obtiene su propio espacio de trabajo aislado en `~/.openclaw/agents/<agent-id>/workspace/`.

### Herramientas

Las **herramientas** son capacidades que el agente puede usar para interactuar con el mundo:

- Leer/escribir archivos
- Ejecutar comandos shell
- Hacer solicitudes HTTP
- Buscar en la web
- Manipular bases de datos
- Y más...

Las herramientas se proporcionan a través de plugins y se pueden extender.

### Memoria

La **memoria** es el contexto a largo plazo del agente. Incluye:

- Conversaciones pasadas (almacenadas en sesiones)
- Resúmenes de interacciones anteriores
- Aprendizajes y preferencias
- Documentación del proyecto

OpenClaw gestiona automáticamente la memoria a través de [compactación de sesión](/es-ES/concepts/compaction) cuando las sesiones se vuelven demasiado largas.

## Ciclo de vida del agente

### 1. Creación

Los agentes se crean automáticamente cuando inicias una nueva conversación:

```bash
openclaw chat
```

O al enviar un mensaje a través de un canal:

```bash
openclaw message send "Hello, agent!"
```

### 2. Ejecución

Una vez creado, el agente:

1. Recibe tu mensaje
2. Procesa el mensaje con su modelo
3. Decide qué herramientas usar (si las hay)
4. Ejecuta herramientas
5. Genera una respuesta
6. Actualiza su sesión con el nuevo contexto

Este proceso se repite para cada interacción.

### 3. Persistencia

Después de cada interacción, el estado del agente (sesión, archivos del espacio de trabajo) se guarda en el disco. Esto permite que los agentes:

- Sobrevivan reinicios
- Reanuden conversaciones más tarde
- Mantengan contexto a largo plazo

### 4. Terminación

Los agentes pueden terminarse:

- Manualmente (saliendo del chat o matando el proceso)
- Automáticamente después de un período de inactividad (configurable)
- Al limpiar sesiones antiguas

## Configuración del agente

Personaliza el comportamiento del agente a través de la configuración:

```bash
# Establecer modelo predeterminado
openclaw config set model.provider anthropic
openclaw config set model.name claude-3-opus-20240229

# Establecer temperatura (aleatoriedad)
openclaw config set model.temperature 0.7

# Establecer max tokens
openclaw config set model.maxTokens 4096

# Habilitar registro detallado
openclaw config set agent.verbose true
```

## Multi-agente

OpenClaw admite ejecutar múltiples agentes simultáneamente. Cada agente:

- Mantiene su propia sesión y espacio de trabajo
- Puede comunicarse con otros agentes
- Puede ser especializado para diferentes tareas

Ver [Multi-agente](/es-ES/concepts/multi-agent) para más detalles.

## Mejores prácticas

### 1. Usa prompts del sistema descriptivos

Proporciona al agente un prompt del sistema claro que describa su propósito y capacidades:

```bash
openclaw chat --system "Eres un asistente útil especializado en Python. Proporciona código limpio y bien documentado."
```

### 2. Gestiona la longitud de las sesiones

Las sesiones largas pueden volverse lentas y costosas. Usa:

- Compactación de sesión automática (habilitada por defecto)
- Podar sesiones manualmente: `openclaw session prune`
- Iniciar nuevas sesiones para tareas no relacionadas

### 3. Organiza espacios de trabajo

Mantén los espacios de trabajo de agentes organizados:

- Usa nombres de archivo descriptivos
- Agrupa archivos relacionados en directorios
- Limpia archivos antiguos o innecesarios

### 4. Monitorea el uso

Realiza un seguimiento del uso de tu agente para evitar costos inesperados:

```bash
openclaw usage
```

### 5. Usa herramientas apropiadas

Habilita solo las herramientas que tu agente necesita:

```bash
openclaw config set tools.enabled "file,shell,http"
```

Esto reduce el riesgo de acciones no deseadas y mejora el rendimiento.

## Ver también

- [Sesiones](/es-ES/concepts/sessions) - Entendiendo las sesiones de agentes
- [Espacio de trabajo del agente](/es-ES/concepts/agent-workspace) - Gestión del espacio de trabajo
- [Multi-agente](/es-ES/concepts/multi-agent) - Ejecutando múltiples agentes
- [Herramientas](/es-ES/tools/overview) - Herramientas disponibles
