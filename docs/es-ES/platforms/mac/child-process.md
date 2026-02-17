---
title: Gestión de Procesos Hijos
description: Cómo la app de macOS gestiona procesos hijos (CLI, gateway, sandbox)
---

# Gestión de Procesos Hijos

La app de macOS gestiona varios procesos hijos de larga duración:

1. **CLI del Gateway** (`openclaw gateway run`)
2. **Servidor de Sandbox** (cuando el sandbox está habilitado)
3. **Procesos de Habilidades** (cuando las habilidades están activas)

## Arquitectura de Procesos

```
OpenClaw.app (proceso principal de SwiftUI)
├── openclaw gateway run (CLI del gateway)
│   └── Agentes (spawned por el gateway)
├── openclaw-sandbox (servidor de sandbox)
└── Procesos de habilidades (cuando están activos)
```

## Ciclo de Vida de los Procesos

### Inicio

1. La app lanza el gateway al iniciar (vía `GatewayManager`)
2. El servidor de sandbox se inicia si está habilitado en la configuración
3. Los procesos de habilidades se inician bajo demanda

### Monitoreo

- La app monitorea el estado de salud del gateway vía `/health`
- Las salidas inesperadas de procesos disparan intentos de reinicio
- Los logs se capturan y reenvían al sistema de logging unificado

### Apagado

1. **Apagado graceful**: señal SIGTERM → espera → SIGKILL si es necesario
2. **Timeout de apagado**: 5 segundos para salida limpia
3. **Limpieza de recursos**: cierre de pipes, handlers de archivos, sockets

## Gestión de Errores

### Fallos de Inicio

- Reintentos con backoff exponencial
- Notificaciones de error al usuario
- Logging para depuración

### Caídas en Tiempo de Ejecución

- Reinicio automático (hasta 3 intentos)
- Preservación del estado cuando sea posible
- Reportes de fallos vía logs del sistema

### Limpieza de Procesos Zombies

- Reaping regular de procesos hijos
- Prevención de fugas de descriptores de archivos
- Limpieza adecuada de recursos IPC

## Depuración

### Logs de Procesos

```bash
# Ver logs del gateway
tail -f ~/.openclaw/logs/gateway.log

# Ver logs de la app de macOS
log stream --predicate 'subsystem == "ai.openclaw.mac"'
```

### Inspección de Procesos

```bash
# Listar procesos relacionados con OpenClaw
ps aux | grep openclaw

# Ver jerarquía de procesos
pstree -p $(pgrep -f "OpenClaw")
```

## Consideraciones de Rendimiento

- **Gestión de memoria**: Los procesos hijos tienen sus propios límites de memoria
- **Aislamiento de CPU**: Cada proceso puede utilizar núcleos separados
- **Uso de handles de archivos**: Monitorear para prevenir agotamiento
- **Recursos IPC**: Los pipes y sockets se limpian adecuadamente
