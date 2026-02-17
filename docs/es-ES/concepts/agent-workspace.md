---
title: "Espacio de trabajo del agente"
description: "Cómo OpenClaw gestiona directorios de trabajo para agentes"
---

# Espacio de trabajo del agente

Cada agente en OpenClaw opera dentro de su propio **espacio de trabajo** aislado: un directorio dedicado donde el agente puede leer archivos, ejecutar comandos y realizar acciones sin interferir con otros agentes o con el sistema de archivos más amplio.

## Descripción general

Los espacios de trabajo del agente proporcionan:

- **Aislamiento**: Cada agente obtiene su propio directorio de trabajo
- **Seguridad**: Los agentes no pueden acceder a archivos fuera de su espacio de trabajo (a menos que se configure explícitamente)
- **Estado persistente**: Los archivos creados durante una sesión permanecen disponibles en sesiones futuras
- **Gestión limpia**: Los espacios de trabajo pueden limpiarse o eliminarse de forma independiente

## Ubicación del espacio de trabajo

Por defecto, los espacios de trabajo del agente se almacenan en:

```
~/.openclaw/agents/<agent-id>/workspace/
```

Donde `<agent-id>` es el identificador único para esa instancia de agente.

### Ejemplo de estructura

```
~/.openclaw/agents/
├── agent-123/
│   ├── workspace/
│   │   ├── file1.txt
│   │   ├── script.py
│   │   └── data/
│   │       └── results.json
│   └── sessions/
│       └── session-456.jsonl
└── agent-789/
    ├── workspace/
    │   └── notes.md
    └── sessions/
        └── session-012.jsonl
```

## Directorio de trabajo

Cuando un agente ejecuta comandos o realiza operaciones de archivos, su **directorio de trabajo actual** se establece en su espacio de trabajo. Esto significa que:

- Las rutas relativas se resuelven dentro del espacio de trabajo
- Los comandos se ejecutan desde el espacio de trabajo
- Los archivos creados van al espacio de trabajo por defecto

### Ejemplo

Si un agente ejecuta:

```bash
echo "Hello" > greeting.txt
```

El archivo `greeting.txt` se crea en `~/.openclaw/agents/<agent-id>/workspace/greeting.txt`, no en el directorio de trabajo del usuario que invocó el comando.

## Configuración del espacio de trabajo

Puedes personalizar el comportamiento del espacio de trabajo a través de la configuración:

### Establecer espacio de trabajo personalizado

```bash
openclaw config set agents.workspace /path/to/custom/workspace
```

### Compartir espacio de trabajo entre agentes

Por defecto, cada agente obtiene su propio espacio de trabajo. Para permitir que múltiples agentes compartan un espacio de trabajo:

```bash
openclaw config set agents.workspaceSharing enabled
```

<Warning>
Compartir espacios de trabajo entre agentes puede llevar a condiciones de carrera y conflictos de archivos. Úsalo solo cuando sea necesario y entiendas las implicaciones.
</Warning>

## Acceso al espacio de trabajo desde código

Al construir herramientas o extensiones personalizadas, puedes acceder al espacio de trabajo del agente a través del objeto de contexto:

```typescript
import { Agent } from 'openclaw/plugin-sdk'

const myTool = {
  name: 'my-tool',
  async execute(context: Agent.Context) {
    const workspace = context.workspace
    
    // Leer archivo desde el espacio de trabajo
    const content = await workspace.readFile('data.json')
    
    // Escribir archivo al espacio de trabajo
    await workspace.writeFile('output.txt', 'Hello World')
    
    // Listar archivos en el espacio de trabajo
    const files = await workspace.listFiles()
    
    return { success: true }
  }
}
```

## Limpieza del espacio de trabajo

Los espacios de trabajo persisten entre sesiones, pero puedes limpiarlos manualmente:

### Limpiar espacio de trabajo de un agente específico

```bash
openclaw agent workspace clean <agent-id>
```

### Limpiar todos los espacios de trabajo

```bash
openclaw agent workspace clean --all
```

### Eliminación automática

Puedes configurar OpenClaw para limpiar automáticamente espacios de trabajo después de un período de inactividad:

```bash
openclaw config set agents.workspaceRetention 30d
```

Esto eliminará espacios de trabajo que no se hayan usado en 30 días.

## Consideraciones de seguridad

### Acceso al sistema de archivos

Por defecto, los agentes **solo** pueden acceder a archivos dentro de su espacio de trabajo. Esto previene:

- Lectura accidental de archivos sensibles
- Modificación de archivos del sistema
- Fuga de datos entre agentes

### Otorgar acceso adicional

Si necesitas que un agente acceda a archivos fuera de su espacio de trabajo, puedes:

1. **Montar directorios adicionales**:
   ```bash
   openclaw agent run --mount /path/to/data:/data
   ```

2. **Deshabilitar restricciones del espacio de trabajo** (no recomendado):
   ```bash
   openclaw config set agents.workspaceRestrictions disabled
   ```

<Warning>
Deshabilitar las restricciones del espacio de trabajo permite a los agentes acceder a cualquier archivo que tu cuenta de usuario pueda acceder. Usa esto solo en entornos de confianza y cuando entiendas completamente los riesgos de seguridad.
</Warning>

## Mejores prácticas

1. **Mantén los espacios de trabajo limpios**: Limpia regularmente archivos antiguos o innecesarios
2. **Usa rutas relativas**: Depende de rutas relativas en lugar de hardcodear rutas absolutas del espacio de trabajo
3. **Documenta las dependencias de archivos**: Si tu agente requiere archivos específicos, documéntalos claramente
4. **Considera el versionado**: Para proyectos a largo plazo, considera usar control de versiones (git) dentro del espacio de trabajo
5. **Haz copias de seguridad de datos importantes**: Los espacios de trabajo no tienen copia de seguridad automática; respalda manualmente cualquier dato crítico

## Ver también

- [Agentes](/es-ES/concepts/agent) - Descripción general del sistema de agentes
- [Sesiones](/es-ES/concepts/sessions) - Cómo funcionan las sesiones de agentes
- [Seguridad](/es-ES/security/overview) - Mejores prácticas de seguridad para OpenClaw
