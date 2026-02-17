---
title: Contexto
description: Cómo el agente recibe contexto sobre el entorno y el usuario
---

El **contexto** se refiere a toda la información que el agente recibe sobre su entorno, el usuario y la conversación actual. OpenClaw proporciona contexto al agente a través del **system prompt** y los **mensajes** en la sesión.

## System Prompt

El system prompt es un mensaje especial que se envía al modelo al inicio de cada solicitud. Contiene:

- **Instrucciones generales** sobre cómo debe comportarse el agente
- **Información del entorno** (directorio de trabajo, plataforma, fecha, etc.)
- **Instrucciones personalizadas** desde archivos `AGENTS.md` / `CLAUDE.md` en el workspace
- **Capacidades de herramientas** disponibles para el agente
- **Contexto de la sesión** (ID del agente, configuración, etc.)

El system prompt se construye dinámicamente para cada solicitud y puede cambiar según:

- El workspace actual
- Las herramientas disponibles
- La configuración del agente
- El estado de la sesión

Consulta [System Prompt](/es-ES/concepts/system-prompt) para más detalles.

## Mensajes

Los mensajes en la sesión proporcionan el contexto conversacional. Incluyen:

- **Mensajes del usuario** que contienen preguntas o solicitudes
- **Respuestas del agente** con texto y llamadas a herramientas
- **Resultados de herramientas** de ejecuciones de herramientas previas
- **Mensajes del sistema** con recordatorios o información de estado

OpenClaw mantiene todo el historial de mensajes en memoria durante la sesión, pero compacta automáticamente sesiones largas para ajustarse a los límites de contexto del modelo.

Consulta [Messages](/es-ES/concepts/messages) para más detalles sobre la estructura de mensajes.

## Instrucciones Personalizadas

Puedes proporcionar contexto adicional al agente colocando un archivo `AGENTS.md` o `CLAUDE.md` en tu workspace. El agente leerá este archivo al inicio de cada sesión y lo incluirá en el system prompt.

Esto es útil para:

- **Pautas específicas del proyecto** sobre estilo de código, arquitectura, etc.
- **Información del dominio** sobre el negocio o producto
- **Procedimientos** para tareas comunes en el proyecto
- **Restricciones** sobre lo que el agente debe o no debe hacer

Ejemplo de `AGENTS.md`:

```markdown
# Pautas del Proyecto

Este es un proyecto React TypeScript que utiliza Vite para construcción y Vitest para pruebas.

## Estilo de Código

- Usa TypeScript estricto con tipos explícitos
- Prefiere componentes funcionales con hooks
- Escribe pruebas para toda nueva funcionalidad
- Usa Prettier para formateo (ejecuta `npm run format`)

## Arquitectura

- Los componentes viven en `src/components/`
- Los hooks viven en `src/hooks/`
- Las utilidades viven en `src/utils/`
- Las pruebas están colocadas junto al código como `*.test.tsx`

## Flujo de Trabajo de Desarrollo

1. Crea una rama desde `main`
2. Realiza cambios con commits pequeños y enfocados
3. Ejecuta `npm test` antes de hacer push
4. Abre un PR para revisión
```

El agente verá estas instrucciones en cada solicitud y las seguirá al trabajar en tu proyecto.

## Directorios de Contexto

Puedes especificar directorios adicionales que el agente debe monitorear para obtener contexto utilizando la configuración `agent.contextDirectories`:

```bash
openclaw config set agent.contextDirectories '["docs", "specs"]'
```

Esto es útil cuando tienes documentación o especificaciones importantes fuera del directorio de trabajo principal.

## Límites de Contexto

Cada modelo tiene un **límite de contexto** máximo (también llamado "ventana de contexto") que especifica cuántos tokens puede procesar en una sola solicitud. OpenClaw maneja esto automáticamente:

- **Compacta** automáticamente sesiones largas cuando se acercan al límite
- **Elimina** resultados de herramientas antiguas mientras preserva mensajes importantes
- **Te avisa** si una sesión se está volviendo demasiado larga

Consulta [Compaction](/es-ES/concepts/compaction) para más detalles sobre cómo funciona esto.

## Límites de Salida

Además de los límites de contexto, los modelos también tienen **límites de salida** máximos que especifican cuántos tokens pueden generar en una sola respuesta. OpenClaw maneja esto:

- **Configurando** el `max_tokens` apropiado para el modelo
- **Permitiendo** que el modelo continúe si es truncado a mitad de una llamada a herramienta
- **Notificándote** si una respuesta fue truncada

Los valores predeterminados están configurados por modelo, pero puedes sobrescribirlos utilizando `agent.maxTokens`:

```bash
openclaw config set agent.maxTokens 8192
```

## Ventanas de Contexto Ampliadas

Algunos modelos ofrecen ventanas de contexto ampliadas opcionales (por ejemplo, Claude con contexto de 200K). OpenClaw soporta estas automáticamente cuando están disponibles a través del proveedor.

Para usar contexto ampliado:

1. **Verifica que tu proveedor lo soporte** (no todos lo hacen)
2. **Configura el modelo apropiado** que soporte contexto ampliado
3. **Sé consciente de los costos** ya que el contexto ampliado a menudo cuesta más

El agente usará automáticamente el límite de contexto completo del modelo sin configuración adicional.

## Contexto en Aplicaciones Multi-agente

En configuraciones multi-agente, cada agente mantiene su propio contexto independiente. Sin embargo, los agentes pueden compartir contexto a través de:

- **Espacios de trabajo compartidos** donde múltiples agentes leen los mismos archivos
- **Paso de mensajes** donde los agentes se comunican entre sí
- **Estado compartido** en bases de datos o archivos

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles sobre coordinación de agentes.
