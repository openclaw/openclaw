---
title: Session Tool
description: Usando la herramienta de sesión para gestionar conversaciones del agente
---

La **herramienta de sesión** (`openclaw session`) proporciona comandos para gestionar sesiones de agentes desde la línea de comandos. Te permite listar, inspeccionar, buscar y manipular sesiones.

## Comandos de Sesión

### Listar Sesiones

Lista todas las sesiones para un agente:

```bash
# Listar todas las sesiones
openclaw session list

# Listar sesiones para un agente específico
openclaw session list --agent my-agent

# Listar solo sesiones activas
openclaw session list --active

# Listar sesiones protegidas
openclaw session list --protected
```

### Ver Sesión

Ver detalles de una sesión específica:

```bash
# Ver sesión por ID
openclaw session show <session-id>

# Ver sesión actual
openclaw session show --current

# Ver con contenido completo de mensajes
openclaw session show <session-id> --full
```

### Buscar Sesiones

Buscar sesiones por contenido:

```bash
# Buscar por texto
openclaw session search "error handling"

# Buscar en un agente específico
openclaw session search "database" --agent my-agent

# Buscar con expresión regular
openclaw session search "user-\d+" --regex
```

### Crear Sesión

Crear una nueva sesión:

```bash
# Crear nueva sesión
openclaw session create

# Crear con nombre
openclaw session create --name "feature-work"

# Crear con workspace
openclaw session create --workspace /path/to/project
```

### Cambiar Sesiones

Cambiar entre sesiones:

```bash
# Cambiar a sesión por ID
openclaw session switch <session-id>

# Cambiar a sesión por nombre
openclaw session switch --name "feature-work"

# Cambiar a sesión anterior
openclaw session switch --previous
```

### Renombrar Sesión

Dar un nombre legible a una sesión:

```bash
# Renombrar sesión actual
openclaw session rename "new-name"

# Renombrar sesión específica
openclaw session rename <session-id> "new-name"
```

### Eliminar Sesiones

Eliminar sesiones:

```bash
# Eliminar sesión por ID
openclaw session delete <session-id>

# Eliminar sesión actual
openclaw session delete --current

# Eliminar todas las sesiones inactivas
openclaw session delete --inactive

# Eliminar sesiones más antiguas que 30 días
openclaw session delete --older-than 30d
```

### Resetear Sesión

Resetear una sesión a un estado limpio:

```bash
# Resetear sesión actual
openclaw session reset

# Resetear sesión específica
openclaw session reset <session-id>

# Resetear pero mantener configuración de workspace
openclaw session reset --keep-workspace
```

### Exportar Sesión

Exportar sesión a un archivo:

```bash
# Exportar a JSON
openclaw session export <session-id> --format json > session.json

# Exportar a Markdown
openclaw session export <session-id> --format markdown > session.md

# Exportar solo mensajes
openclaw session export <session-id> --messages-only > messages.json
```

### Importar Sesión

Importar sesión desde un archivo:

```bash
# Importar desde JSON
openclaw session import session.json

# Importar con nombre
openclaw session import session.json --name "imported-session"

# Importar a agente específico
openclaw session import session.json --agent my-agent
```

## Gestión de Sesiones

### Proteger Sesiones

Prevenir que sesiones importantes sean podadas:

```bash
# Proteger sesión actual
openclaw session protect

# Proteger sesión específica
openclaw session protect <session-id>

# Desproteger sesión
openclaw session unprotect <session-id>
```

### Marcar Sesiones

Marcar sesiones importantes para referencia fácil:

```bash
# Marcar sesión actual
openclaw session bookmark

# Marcar sesión específica
openclaw session bookmark <session-id> --note "good example"

# Listar sesiones marcadas
openclaw session list --bookmarked

# Remover marca
openclaw session unbookmark <session-id>
```

### Archivar Sesiones

Archivar sesiones antiguas para ahorrar espacio:

```bash
# Archivar sesión
openclaw session archive <session-id>

# Archivar todas las sesiones inactivas
openclaw session archive --inactive

# Archivar sesiones más antiguas que 30 días
openclaw session archive --older-than 30d

# Listar sesiones archivadas
openclaw session list --archived
```

### Restaurar Sesiones

Restaurar sesiones archivadas:

```bash
# Restaurar sesión archivada
openclaw session restore <session-id>

# Restaurar todas las sesiones archivadas
openclaw session restore --all
```

## Inspección de Sesiones

### Ver Mensajes

Ver mensajes en una sesión:

```bash
# Ver todos los mensajes
openclaw session messages <session-id>

# Ver últimos 10 mensajes
openclaw session messages <session-id> --tail 10

# Ver mensajes con rango de tiempo
openclaw session messages <session-id> --since 2024-01-01

# Ver solo mensajes del usuario
openclaw session messages <session-id> --role user
```

### Ver Uso

Ver estadísticas de uso para una sesión:

```bash
# Ver uso de tokens
openclaw session usage <session-id>

# Ver uso con desglose por modelo
openclaw session usage <session-id> --by-model

# Ver costo estimado
openclaw session usage <session-id> --cost
```

### Ver Herramientas

Ver llamadas a herramientas en una sesión:

```bash
# Listar todas las llamadas a herramientas
openclaw session tools <session-id>

# Listar llamadas a una herramienta específica
openclaw session tools <session-id> --name read_file

# Ver con entradas/salidas completas
openclaw session tools <session-id> --full
```

### Ver Errores

Ver errores en una sesión:

```bash
# Listar todos los errores
openclaw session errors <session-id>

# Ver con stack traces completos
openclaw session errors <session-id> --full

# Filtrar por tipo de error
openclaw session errors <session-id> --type rate_limit_error
```

## Estadísticas de Sesiones

### Resumen de Sesiones

Ver estadísticas de resumen:

```bash
# Ver resumen de todas las sesiones
openclaw session stats

# Ver resumen para agente específico
openclaw session stats --agent my-agent

# Ver resumen con desglose por modelo
openclaw session stats --by-model
```

Muestra:

- Número total de sesiones
- Sesiones activas/inactivas
- Uso total de tokens
- Costo total estimado
- Tamaño promedio de sesión

### Línea de Tiempo de Sesión

Ver actividad de sesión a lo largo del tiempo:

```bash
# Ver línea de tiempo para sesión
openclaw session timeline <session-id>

# Ver línea de tiempo con visualización por hora
openclaw session timeline <session-id> --by-hour

# Ver línea de tiempo para rango de fechas
openclaw session timeline <session-id> --since 2024-01-01 --until 2024-01-31
```

## Formato de Salida

La herramienta de sesión soporta múltiples formatos de salida:

```bash
# Salida en tabla (predeterminado)
openclaw session list

# Salida en JSON
openclaw session list --format json

# Salida en YAML
openclaw session list --format yaml

# Salida en CSV
openclaw session list --format csv

# Solo IDs (para scripting)
openclaw session list --format ids
```

## Sesiones y Workspaces

Las sesiones están vinculadas a workspaces. Cuando creas o cambias de sesión, también puedes cambiar de workspace:

```bash
# Crear sesión con workspace
openclaw session create --workspace /path/to/project

# Cambiar sesión y workspace
openclaw session switch <session-id> --workspace /different/project

# Ver workspace de sesión
openclaw session show <session-id> | grep workspace
```

## Sesiones Multi-agente

Cuando trabajas con múltiples agentes:

```bash
# Listar sesiones para todos los agentes
openclaw session list --all-agents

# Ver qué agente posee una sesión
openclaw session show <session-id> | grep agent

# Crear sesión para agente específico
openclaw session create --agent my-agent
```

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Scripting con la Herramienta de Sesión

La herramienta de sesión está diseñada para scripting:

```bash
# Obtener ID de sesión actual
CURRENT_SESSION=$(openclaw session list --current --format ids)

# Contar número de sesiones
NUM_SESSIONS=$(openclaw session list --format ids | wc -l)

# Encontrar sesiones antiguas
OLD_SESSIONS=$(openclaw session list --older-than 30d --format ids)

# Eliminar sesiones antiguas
for session in $OLD_SESSIONS; do
  openclaw session delete $session
done
```

## Mejores Prácticas

### Nombrar Sesiones

- **Usa nombres descriptivos** para sesiones importantes
- **Incluye contexto** (por ejemplo, "bug-123-fix", "feature-search")
- **Usa convenciones consistentes** en tu equipo

### Organizar Sesiones

- **Protege sesiones importantes** para prevenir poda accidental
- **Marca buenas sesiones** para referencia futura
- **Archiva sesiones viejas** para ahorrar espacio
- **Elimina sesiones experimentales** cuando hayas terminado

### Monitoreo

- **Revisa estadísticas de sesión** regularmente
- **Rastrea uso de tokens** para gestión de costos
- **Identifica sesiones problemáticas** (muchos errores, uso alto)
- **Limpia sesiones inactivas** periódicamente

### Respaldo

- **Exporta sesiones importantes** para respaldo
- **Versioniza archivos de sesión exportados** en git
- **Documenta sesiones clave** con notas/marcadores
- **Comparte sesiones** con el equipo cuando sea útil

## Solución de Problemas

### No se Puede Encontrar Sesión

Si no puedes encontrar una sesión:

1. **Verifica el ID de sesión**: ¿Es correcto?
2. **Verifica el agente**: ¿Estás buscando en el agente correcto?
3. **Verifica si archivado**: Usa `--archived` para ver sesiones archivadas
4. **Busca por contenido**: Usa `openclaw session search`

### Sesión No Cambia

Si no puedes cambiar de sesión:

1. **Verifica que la sesión exista**: `openclaw session show <id>`
2. **Verifica el workspace**: ¿El workspace aún existe?
3. **Verifica permisos**: ¿Puedes acceder al archivo de sesión?
4. **Resetea si está corrupto**: `openclaw session reset`

### Exportación/Importación Falla

Si exportar/importar falla:

1. **Verifica el formato**: ¿Formato JSON/Markdown válido?
2. **Verifica permisos de archivo**: ¿Puedes leer/escribir el archivo?
3. **Verifica tamaño**: ¿El archivo es demasiado grande?
4. **Revisa logs**: `openclaw logs --filter session`

## Referencias API

OpenClaw proporciona APIs programáticas para gestión de sesiones:

```typescript
import { SessionManager } from "openclaw";

// Listar sesiones
const sessions = await manager.list();

// Crear sesión
const session = await manager.create({
  name: "my-session",
  workspace: "/path/to/project",
});

// Cambiar sesión
await manager.switch(sessionId);

// Eliminar sesión
await manager.delete(sessionId);
```

Consulta la [Referencia API](/es-ES/api/session) para documentación completa.
