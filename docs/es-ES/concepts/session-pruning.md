---
title: Session Pruning
description: Cómo OpenClaw poda automáticamente sesiones antiguas
---

**Session pruning** es el proceso de limpiar automáticamente sesiones antiguas o inactivas para ahorrar espacio en disco y mantener el rendimiento del sistema. OpenClaw puede podar sesiones según edad, tamaño o inactividad.

## Cómo Funciona

OpenClaw revisa periódicamente las sesiones y elimina aquellas que cumplen criterios de poda:

- **Sesiones antiguas**: Más antiguas que un umbral de edad
- **Sesiones inactivas**: Sin actividad durante un período
- **Sesiones grandes**: Más grandes que un umbral de tamaño

Los archivos de sesión podados se eliminan del disco permanentemente.

## Configuración de Poda

### Poda por Edad

Elimina sesiones más antiguas que un cierto período:

```bash
# Podar sesiones más antiguas que 30 días
openclaw config set agent.pruning.maxAge 30d

# Podar sesiones más antiguas que 7 días
openclaw config set agent.pruning.maxAge 7d

# Deshabilitar poda por edad
openclaw config set agent.pruning.maxAge ""
```

Formatos de tiempo soportados:

- `30d` - 30 días
- `4w` - 4 semanas
- `6m` - 6 meses
- `1y` - 1 año

### Poda por Inactividad

Elimina sesiones sin actividad durante un período:

```bash
# Podar sesiones inactivas durante 14 días
openclaw config set agent.pruning.maxInactivity 14d

# Podar sesiones inactivas durante 1 semana
openclaw config set agent.pruning.maxInactivity 7d

# Deshabilitar poda por inactividad
openclaw config set agent.pruning.maxInactivity ""
```

Una sesión se considera inactiva si no tiene nuevos mensajes durante el período especificado.

### Poda por Tamaño

Elimina sesiones más grandes que un cierto tamaño:

```bash
# Podar sesiones más grandes que 100MB
openclaw config set agent.pruning.maxSize 100MB

# Podar sesiones más grandes que 1GB
openclaw config set agent.pruning.maxSize 1GB

# Deshabilitar poda por tamaño
openclaw config set agent.pruning.maxSize ""
```

### Programación de Poda

Controla con qué frecuencia ocurre la poda:

```bash
# Ejecutar poda cada 24 horas (predeterminado)
openclaw config set agent.pruning.schedule "0 0 * * *"

# Ejecutar poda cada hora
openclaw config set agent.pruning.schedule "0 * * * *"

# Ejecutar poda cada lunes a las 3am
openclaw config set agent.pruning.schedule "0 3 * * 1"
```

La programación usa sintaxis cron.

## Poda Manual

Puedes ejecutar poda manualmente en cualquier momento:

```bash
# Ejecutar poda ahora
openclaw session prune

# Vista previa de poda sin eliminar
openclaw session prune --dry-run

# Podar sesiones específicas
openclaw session prune --agent my-agent

# Podar sesiones más antiguas que 7 días
openclaw session prune --older-than 7d
```

## Sesiones Protegidas

Puedes proteger sesiones importantes de la poda:

```bash
# Proteger una sesión de poda
openclaw session protect <session-id>

# Desproteger una sesión
openclaw session unprotect <session-id>

# Listar sesiones protegidas
openclaw session list --protected
```

Las sesiones protegidas nunca se podan automáticamente.

### Protección Automática

Protege automáticamente ciertos tipos de sesiones:

```bash
# Proteger sesiones con marcadores
openclaw config set agent.pruning.protectBookmarked true

# Proteger sesiones nombradas
openclaw config set agent.pruning.protectNamed true

# Proteger sesiones activas
openclaw config set agent.pruning.protectActive true
```

## Archivado vs Poda

En lugar de podar, puedes archivar sesiones antiguas:

```bash
# Archivar sesiones más antiguas que 30 días
openclaw config set agent.archiving.maxAge 30d

# Ubicación de archivo
openclaw config set agent.archiving.path "~/.openclaw/archive"
```

Las sesiones archivadas:

- **Se mueven al directorio de archivo**
- **Se comprimen** para ahorrar espacio
- **Aún se pueden acceder** pero son más lentas de cargar
- **No se podan** hasta que cumplen criterios de archivado

## Estadísticas de Poda

Ver estadísticas sobre sesiones podadas:

```bash
# Ver estadísticas de poda
openclaw session prune --stats
```

Esto muestra:

- Cuántas sesiones fueron podadas
- Cuándo ocurrió la última poda
- Cuánto espacio se liberó
- Qué sesiones fueron podadas

## Logging de Poda

OpenClaw registra todas las operaciones de poda:

```
[pruning] Starting session pruning
[pruning] Pruned session abc123 (age: 45d, size: 120MB)
[pruning] Pruned session def456 (inactive: 20d)
[pruning] Pruning complete: 2 sessions pruned, 240MB freed
```

Visualiza logs en tiempo real con:

```bash
openclaw logs --follow --filter pruning
```

## Recuperación

Las sesiones podadas no se pueden recuperar a menos que tengas respaldos. Para prevenir pérdida accidental:

### Habilitar Respaldos

```bash
# Habilitar respaldos automáticos antes de podar
openclaw config set agent.pruning.backup true

# Ubicación de respaldo
openclaw config set agent.pruning.backupPath "~/.openclaw/backups"
```

### Período de Retención de Respaldos

```bash
# Mantener respaldos durante 30 días
openclaw config set agent.pruning.backupRetention 30d
```

Los respaldos más antiguos que el período de retención se eliminan automáticamente.

## Mejores Prácticas

### Política de Poda

- **Usa poda por edad** para limpieza general (30-90 días)
- **Usa poda por inactividad** para sesiones abandonadas (14-30 días)
- **Usa poda por tamaño** para sesiones runaway (100MB-1GB)
- **Protege sesiones importantes** que quieres mantener

### Programación

- **Ejecuta poda fuera de horas pico** (por ejemplo, 3am)
- **Ejecuta con suficiente frecuencia** para prevenir acumulación (diario/semanal)
- **No ejecutes demasiado frecuentemente** (desperdicia recursos)

### Respaldo

- **Habilita respaldos** para configuraciones de producción
- **Establece retención razonable** (30-90 días)
- **Prueba recuperación de respaldo** periódicamente
- **Monitorea uso de espacio de respaldo**

### Monitoreo

- **Monitorea espacio en disco** para prevenir quedarse sin espacio
- **Rastrea tasa de poda** para identificar problemas
- **Revisa logs de poda** para errores inesperados
- **Alerta en sesiones grandes** antes de que causen problemas

## Poda Multi-agente

En configuraciones multi-agente, cada agente tiene su propia configuración de poda:

- **Políticas de poda independientes**: Cada agente puede tener diferentes reglas
- **Programaciones independientes**: Los agentes pueden podar en diferentes momentos
- **Sesiones protegidas independientes**: Cada agente protege sus propias sesiones

Sin embargo:

- **El espacio en disco es compartido**: Todos los agentes usan el mismo disco
- **Los respaldos pueden ser compartidos**: Puedes usar una ubicación de respaldo común
- **El monitoreo debe considerar todos los agentes**: Rastrea uso total en disco

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Solución de Problemas

### Quedarse sin Espacio en Disco

Si te estás quedando sin espacio en disco:

1. **Ejecuta poda manual**: `openclaw session prune`
2. **Reduce umbrales de poda**: Poda sesiones más viejas/grandes
3. **Habilita compresión**: Comprime archivos de sesión
4. **Mueve sesiones antiguas**: Archiva en lugar de podar

### Sesiones Importantes Podadas

Si sesiones importantes fueron podadas:

1. **Verifica respaldos**: Restaura desde respaldo si está habilitado
2. **Revisa logs de poda**: Verifica por qué fueron podadas
3. **Protege sesiones similares**: Previene poda futura
4. **Ajusta umbrales**: Poda menos agresivamente

### Poda No Funciona

Si la poda no está funcionando:

1. **Verifica que la poda esté habilitada**: `agent.pruning.maxAge` configurado
2. **Verifica la programación**: ¿Se está ejecutando la poda?
3. **Verifica permisos**: ¿Puede OpenClaw eliminar archivos?
4. **Revisa logs**: ¿Hay errores de poda?

### Poda Demasiado Lenta

Si la poda toma demasiado tiempo:

1. **Poda más frecuentemente**: Menos sesiones por ejecución
2. **Aumenta umbrales**: Poda menos sesiones
3. **Deshabilita respaldos**: Ahorra tiempo (usa con cuidado)
4. **Usa SSD**: I/O de disco más rápido

## Referencias API

OpenClaw proporciona APIs programáticas para poda de sesiones:

```typescript
import { SessionPruner } from "openclaw";

// Ejecutar poda
const result = await pruner.prune({
  maxAge: "30d",
  maxInactivity: "14d",
  maxSize: "100MB",
  dryRun: false,
});

// Proteger sesión
await pruner.protect(sessionId);

// Desproteger sesión
await pruner.unprotect(sessionId);
```

Consulta la [Referencia API](/es-ES/api/session-pruning) para documentación completa.
