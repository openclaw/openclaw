---
summary: "Qué contiene el system prompt de OpenClaw y cómo se ensambla"
read_when:
  - Edición del texto del system prompt, la lista de herramientas o las secciones de tiempo/latidos
  - Cambio del bootstrap del espacio de trabajo o del comportamiento de inyección de Skills
title: "System Prompt"
---

# System Prompt

OpenClaw construye un system prompt personalizado para cada ejecución de agente. El prompt es **propiedad de OpenClaw** y no utiliza el prompt predeterminado de p-coding-agent.

El prompt es ensamblado por OpenClaw e inyectado en cada ejecución del agente.

## Estructura

El prompt es intencionalmente compacto y utiliza secciones fijas:

- **Tooling**: lista actual de herramientas + descripciones cortas.
- **Safety**: breve recordatorio de guardrails para evitar comportamientos de búsqueda de poder o eludir la supervisión.
- **Skills** (cuando están disponibles): indica al modelo cómo cargar instrucciones de skills bajo demanda.
- **OpenClaw Self-Update**: cómo ejecutar `config.apply` y `update.run`.
- **Workspace**: directorio de trabajo (`agents.defaults.workspace`).
- **Documentation**: ruta local a la documentación de OpenClaw (repositorio o paquete npm) y cuándo leerla.
- **Workspace Files (injected)**: indica que los archivos de bootstrap se incluyen a continuación.
- **Sandbox** (cuando está habilitado): indica el runtime en sandbox, las rutas del sandbox y si la ejecución con privilegios elevados está disponible.
- **Current Date & Time**: hora local del usuario, zona horaria y formato de hora.
- **Reply Tags**: sintaxis opcional de etiquetas de respuesta para proveedores compatibles.
- **Heartbeats**: prompt de latidos y comportamiento de confirmación.
- **Runtime**: host, SO, node, modelo, raíz del repositorio (cuando se detecta), nivel de razonamiento (una línea).
- **Reasoning**: nivel de visibilidad actual + pista del interruptor /reasoning.

Los guardrails de seguridad en el system prompt son orientativos. Guían el comportamiento del modelo, pero no imponen políticas. Use políticas de herramientas, aprobaciones de exec, sandboxing y listas de permitidos de canales para una aplicación estricta; los operadores pueden deshabilitarlos por diseño.

## Modos del prompt

OpenClaw puede renderizar system prompts más pequeños para subagentes. El runtime establece un
`promptMode` para cada ejecución (no es una configuración visible para el usuario):

- `full` (predeterminado): incluye todas las secciones anteriores.
- `minimal`: usado para subagentes; omite **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** y **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (cuando se conoce), Runtime y el contexto
  inyectado permanecen disponibles.
- `none`: devuelve solo la línea base de identidad.

Cuando `promptMode=minimal`, los prompts adicionales inyectados se etiquetan como **Subagent
Context** en lugar de **Group Chat Context**.

## Inyección del bootstrap del espacio de trabajo

Los archivos de bootstrap se recortan y se anexan bajo **Project Context** para que el modelo vea el contexto de identidad y perfil sin necesidad de lecturas explícitas:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (solo en espacios de trabajo completamente nuevos)

Los archivos grandes se truncan con un marcador. El tamaño máximo por archivo está controlado por
`agents.defaults.bootstrapMaxChars` (predeterminado: 20000). Los archivos faltantes inyectan un
marcador corto de archivo faltante.

Los hooks internos pueden interceptar este paso mediante `agent:bootstrap` para mutar o reemplazar
los archivos de bootstrap inyectados (por ejemplo, intercambiar `SOUL.md` por una persona alternativa).

Para inspeccionar cuánto contribuye cada archivo inyectado (en bruto vs inyectado, truncamiento, además de la sobrecarga del esquema de herramientas), use `/context list` o `/context detail`. Consulte [Context](/concepts/context).

## Manejo del tiempo

El system prompt incluye una sección dedicada **Current Date & Time** cuando se conoce la zona horaria del usuario. Para mantener estable la caché del prompt, ahora solo incluye la **zona horaria** (sin reloj dinámico ni formato de hora).

Use `session_status` cuando el agente necesite la hora actual; la tarjeta de estado
incluye una línea de marca de tiempo.

Configure con:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Consulte [Date & Time](/date-time) para conocer todos los detalles de comportamiento.

## Skills

Cuando existen skills elegibles, OpenClaw inyecta una **lista compacta de skills disponibles**
(`formatSkillsForPrompt`) que incluye la **ruta del archivo** para cada skill. El
prompt instruye al modelo a usar `read` para cargar el SKILL.md en la ubicación listada
(espacio de trabajo, administrado o incluido). Si no hay skills elegibles, la
sección Skills se omite.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Esto mantiene el prompt base pequeño y aun así habilita el uso dirigido de skills.

## Documentation

Cuando está disponible, el system prompt incluye una sección **Documentation** que apunta al
directorio local de documentación de OpenClaw (ya sea `docs/` en el espacio de trabajo del repositorio o la documentación incluida del paquete npm) y también menciona el mirror público, el repositorio fuente, el Discord de la comunidad y
ClawHub ([https://clawhub.com](https://clawhub.com)) para el descubrimiento de skills. El prompt instruye al modelo a consultar primero la documentación local
para el comportamiento, comandos, configuración o arquitectura de OpenClaw, y a ejecutar
`openclaw status` por sí mismo cuando sea posible (preguntando al usuario solo cuando carece de acceso).
