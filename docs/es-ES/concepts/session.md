---
title: Sesión
description: Entendiendo sesiones y cómo gestiona OpenClaw el estado conversacional
---

Una **sesión** es una conversación única entre el usuario y el agente. Cada sesión tiene su propio historial de mensajes, contexto y estado. Las sesiones permiten al agente mantener conversaciones de larga duración a lo largo de múltiples interacciones.

## ¿Qué es una Sesión?

Una sesión contiene:

- **Historial de mensajes**: Todos los mensajes intercambiados entre el usuario y el agente
- **Ejecuciones de herramientas**: Todas las herramientas llamadas y sus resultados
- **Metadatos**: Workspace, configuración, marcas de tiempo, uso de tokens
- **Estado**: Sesión activa/inactiva, última actividad, etc.

Las sesiones se almacenan en:

```
~/.openclaw/sessions/<agent-id>/<session-id>.jsonl
```

Cada línea en el archivo es un evento JSON (mensaje, llamada a herramienta, etc.).

## Ciclo de Vida de la Sesión

### Creación

Una sesión se crea cuando:

- Envías tu primer mensaje al agente
- Creas explícitamente una sesión con `openclaw session create`
- Cambias a una sesión que no existe todavía

```bash
# Crear nueva sesión
openclaw session create

# Crear con nombre
openclaw session create --name "feature-work"

# Crear con workspace
openclaw session create --workspace /path/to/project
```

### Sesión Activa

Una vez creada, la sesión se convierte en la **sesión activa**. Todos los mensajes van a la sesión activa:

```bash
# Ver sesión activa
openclaw session list --current

# Enviar mensaje a sesión activa
openclaw message send "Hola, agente"
```

### Cambiar Sesiones

Puedes cambiar entre sesiones:

```bash
# Cambiar a sesión diferente
openclaw session switch <session-id>

# Cambiar por nombre
openclaw session switch --name "feature-work"
```

Cuando cambias:

- La sesión anterior permanece pero no está activa
- Los nuevos mensajes van a la nueva sesión activa
- Cada sesión mantiene su propio historial

### Resetear Sesión

Resetear limpia el historial de una sesión pero mantiene el workspace:

```bash
# Resetear sesión actual
openclaw session reset

# Resetear sesión específica
openclaw session reset <session-id>
```

Esto es útil cuando quieres comenzar de nuevo sin crear una nueva sesión.

### Eliminar Sesión

Eliminar elimina permanentemente una sesión:

```bash
# Eliminar sesión
openclaw session delete <session-id>

# Eliminar sesión actual
openclaw session delete --current
```

Las sesiones eliminadas no se pueden recuperar (a menos que tengas respaldos).

## Aislamiento de Sesión

Cada sesión es completamente independiente:

- **Historial de mensajes separado**: Las sesiones no comparten mensajes
- **Contexto separado**: Cada sesión tiene su propio contexto
- **Estado separado**: Las sesiones no interfieren entre sí

Esto permite:

- **Múltiples conversaciones** en paralelo
- **Cambio de contexto** entre tareas
- **Experimentación** sin afectar otro trabajo

## Sesión y Workspace

Las sesiones están vinculadas a **workspaces** (directorios). El workspace de una sesión determina:

- **Directorio de trabajo**: Dónde ejecuta el agente los comandos
- **Archivos de contexto**: Qué archivos `AGENTS.md` / `CLAUDE.md` leer
- **Rutas relativas**: Cómo resuelve el agente las rutas de archivo

Establecer workspace al crear una sesión:

```bash
openclaw session create --workspace /path/to/project
```

O cambiar el workspace de una sesión existente:

```bash
openclaw session switch <session-id> --workspace /different/project
```

## Nombrar Sesiones

Por defecto, las sesiones obtienen IDs aleatorios (por ejemplo, `abc123`). Puedes darles nombres legibles:

```bash
# Renombrar sesión
openclaw session rename <session-id> "feature-auth"

# Crear con nombre
openclaw session create --name "bug-fix-456"

# Cambiar por nombre
openclaw session switch --name "feature-auth"
```

Los nombres facilitan recordar qué sesión es cuál.

## Persistencia de Sesión

Las sesiones se guardan automáticamente en disco:

- **Después de cada mensaje** para prevenir pérdida de datos
- **Después de cada llamada a herramienta** para capturar resultados
- **Al cerrar** para asegurar que no se pierda nada

Las sesiones sobreviven:

- **Reinicios del gateway**: Las sesiones se restauran al reiniciar
- **Bloqueos**: Las sesiones se guardan antes de cada operación
- **Cierres de sistema**: Las sesiones se escriben en disco inmediatamente

## Metadatos de Sesión

Cada sesión rastrea metadatos:

- **Creado en**: Cuándo se creó la sesión
- **Última actividad**: Cuándo se usó por última vez la sesión
- **Uso de tokens**: Cuántos tokens se han usado
- **Conteo de mensajes**: Cuántos mensajes están en la sesión
- **Workspace**: A qué directorio está vinculada la sesión
- **Modelo**: Qué modelo(s) usa la sesión

Visualiza metadatos con:

```bash
openclaw session show <session-id>
```

## Compactación de Sesión

Las sesiones largas se compactan automáticamente para ajustarse dentro de los límites de contexto del modelo. Esto implica:

- **Eliminar resultados de herramientas antiguas**
- **Preservar mensajes importantes**
- **Mantener mensajes recientes intactos**

La compactación es transparente—solo nota que las sesiones antiguas pueden no tener todos los resultados de herramientas.

Consulta [Compaction](/es-ES/concepts/compaction) para más detalles.

## Protección de Sesión

Protege sesiones importantes de la poda automática:

```bash
# Proteger sesión
openclaw session protect <session-id>

# Desproteger sesión
openclaw session unprotect <session-id>
```

Las sesiones protegidas nunca se podan automáticamente, incluso si son antiguas o inactivas.

## Marcado de Sesión

Marca sesiones importantes para referencia fácil:

```bash
# Marcar sesión
openclaw session bookmark <session-id> --note "buena solución de bug"

# Listar sesiones marcadas
openclaw session list --bookmarked

# Desmarcar sesión
openclaw session unbookmark <session-id>
```

Los marcadores son útiles para:

- **Guardar buenos ejemplos** de resolución de problemas
- **Marcar sesiones de referencia** para compartir con el equipo
- **Rastrear conversaciones importantes** para seguimiento

## Exportar/Importar Sesiones

Exporta sesiones para respaldo o compartir:

```bash
# Exportar a JSON
openclaw session export <session-id> --format json > session.json

# Exportar a Markdown
openclaw session export <session-id> --format markdown > session.md
```

Importa sesiones desde archivos:

```bash
# Importar desde JSON
openclaw session import session.json --name "imported-session"
```

Esto es útil para:

- **Compartir sesiones** con compañeros de equipo
- **Respaldar sesiones importantes**
- **Mover sesiones** entre máquinas
- **Versionar sesiones** en git

## Buscar Sesiones

Busca sesiones por contenido:

```bash
# Buscar en todas las sesiones
openclaw session search "error handling"

# Buscar con regex
openclaw session search "user-\d+" --regex

# Buscar en agente específico
openclaw session search "database" --agent my-agent
```

Esto busca en todos los mensajes, llamadas a herramientas y resultados.

## Sesiones Multi-agente

Cuando ejecutas múltiples agentes, cada agente tiene sus propias sesiones:

- **Sesiones separadas**: Los agentes no comparten sesiones
- **Sesiones activas separadas**: Cada agente tiene su propia sesión activa
- **Listas de sesiones separadas**: `openclaw session list` muestra sesiones del agente actual

Para ver sesiones de todos los agentes:

```bash
openclaw session list --all-agents
```

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Estadísticas de Sesión

Ver estadísticas sobre sesiones:

```bash
# Estadísticas de todas las sesiones
openclaw session stats

# Estadísticas para agente específico
openclaw session stats --agent my-agent

# Estadísticas con desglose por modelo
openclaw session stats --by-model
```

Esto muestra:

- Número total de sesiones
- Sesiones activas vs inactivas
- Uso total de tokens
- Costo estimado
- Tamaño promedio de sesión

## Poda de Sesión

Las sesiones antiguas se podan automáticamente para ahorrar espacio. Configura poda con:

```bash
# Podar sesiones más antiguas que 30 días
openclaw config set agent.pruning.maxAge 30d

# Podar sesiones inactivas durante 14 días
openclaw config set agent.pruning.maxInactivity 14d
```

Consulta [Session Pruning](/es-ES/concepts/session-pruning) para más detalles.

## Mejores Prácticas

### Organización de Sesiones

- **Usa nombres descriptivos** para sesiones importantes
- **Crea nuevas sesiones** para diferentes tareas/contextos
- **Resetea sesiones** cuando cambias de tarea
- **Elimina sesiones experimentales** cuando hayas terminado

### Gestión de Sesiones

- **Protege sesiones importantes** de poda
- **Marca buenas sesiones** para referencia futura
- **Exporta sesiones críticas** para respaldo
- **Revisa y limpia** sesiones antiguas regularmente

### Rendimiento

- **Resetea sesiones largas** si se vuelven lentas
- **Monitorea tamaño de sesión** para gestión de contexto
- **Usa múltiples sesiones** en lugar de una sesión larga
- **Compacta manualmente** si es necesario

### Compartir

- **Exporta como Markdown** para legibilidad
- **Incluye metadatos** al exportar
- **Redacta información sensible** antes de compartir
- **Versioniza en git** para colaboración del equipo

## Solución de Problemas

### Sesión No Se Guarda

Si los cambios en la sesión no se guardan:

1. **Verifica permisos**: ¿Puedes escribir en `~/.openclaw/sessions/`?
2. **Verifica espacio en disco**: ¿Hay espacio suficiente?
3. **Revisa logs**: `openclaw logs --filter session`
4. **Reinicia gateway**: Puede estar atascado

### Sesión Corrupta

Si una sesión está corrupta:

1. **Intenta exportar**: Rescata lo que puedas
2. **Resetea la sesión**: Limpia el estado corrupto
3. **Elimina y recrea**: Último recurso
4. **Revisa respaldos**: Si habilitaste respaldo

### Sesión Lenta

Si una sesión se vuelve lenta:

1. **Verifica el tamaño**: `openclaw session show <id> | grep size`
2. **Compacta manualmente**: `openclaw session compact <id>`
3. **Resetea si es demasiado grande**: Comienza de nuevo
4. **Usa nueva sesión**: Más rápido que resetear

## Referencias API

OpenClaw proporciona APIs programáticas para gestión de sesiones:

```typescript
import { SessionManager } from 'openclaw'

// Crear sesión
const session = await manager.create({
  name: 'my-session',
  workspace: '/path/to/project',
})

// Enviar mensaje
await manager.sendMessage(session.id, 'Hola')

// Obtener historial
const messages = await manager.getMessages(session.id)

// Exportar sesión
const data = await manager.export(session.id, { format: 'json' })
```

Consulta la [Referencia API](/es-ES/api/session) para documentación completa.
