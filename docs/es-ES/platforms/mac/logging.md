---
title: Logging
description: Sistema de logging de la app de macOS de OpenClaw
---

# Logging

La app de macOS de OpenClaw utiliza el sistema de logging unificado de Apple para diagnósticos y depuración.

## Subsistemas de Logging

### Subsistema Principal

```
ai.openclaw.mac
```

### Categorías

- `app`: Eventos del ciclo de vida de la aplicación
- `gateway`: Operaciones del gateway
- `health`: Verificaciones de monitoreo de salud
- `ui`: Eventos de la interfaz de usuario
- `skills`: Ejecución de habilidades
- `sandbox`: Operaciones del sandbox

## Niveles de Log

1. **Debug**: Información detallada de depuración
2. **Info**: Eventos operacionales generales
3. **Notice**: Eventos significativos pero normales
4. **Error**: Condiciones de error
5. **Fault**: Fallos críticos del sistema

## Visualización de Logs

### Usando Console.app

1. Abre Console.app
2. Filtra por subsistema: `subsystem:ai.openclaw.mac`
3. Ajusta el nivel de log según sea necesario

### Usando Terminal

```bash
# Stream de todos los logs de OpenClaw
log stream --predicate 'subsystem == "ai.openclaw.mac"'

# Filtrar por categoría
log stream --predicate 'subsystem == "ai.openclaw.mac" AND category == "gateway"'

# Filtrar por nivel
log stream --predicate 'subsystem == "ai.openclaw.mac"' --level debug

# Mostrar logs históricos
log show --predicate 'subsystem == "ai.openclaw.mac"' --last 1h
```

### Usando el Script de Helper

```bash
# Ver logs recientes
./scripts/clawlog.sh

# Seguir logs en vivo
./scripts/clawlog.sh -f

# Filtrar por categoría
./scripts/clawlog.sh -c gateway
```

## Formato de Logs

```
2026-02-16 10:30:45.123 OpenClaw[1234:56789] [gateway] Gateway started on port 18789
2026-02-16 10:30:46.456 OpenClaw[1234:56789] [health] Health check passed
```

## Mejores Prácticas

- Usa el nivel apropiado para cada mensaje
- Incluye contexto relevante (IDs, estados)
- Evita logging de información sensible
- Usa categorías para organizar logs
