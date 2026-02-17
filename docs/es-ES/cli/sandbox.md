---
title: CLI de Sandbox
summary: "Gestionar contenedores sandbox e inspeccionar la política efectiva de sandbox"
read_when: "Estás gestionando contenedores sandbox o depurando el comportamiento de sandbox/política de herramientas."
status: active
---

# CLI de Sandbox

Gestionar contenedores sandbox basados en Docker para ejecución aislada de agentes.

## Descripción general

OpenClaw puede ejecutar agentes en contenedores Docker aislados por seguridad. Los comandos `sandbox` te ayudan a gestionar estos contenedores, especialmente después de actualizaciones o cambios de configuración.

## Comandos

### `openclaw sandbox explain`

Inspeccionar el modo/alcance/acceso al espacio de trabajo sandbox **efectivo**, la política de herramientas de sandbox y las puertas elevadas (con rutas de claves de configuración para correcciones).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Listar todos los contenedores sandbox con su estado y configuración.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # Listar solo contenedores de navegador
openclaw sandbox list --json     # Salida JSON
```

**La salida incluye:**

- Nombre del contenedor y estado (en ejecución/detenido)
- Imagen Docker y si coincide con la configuración
- Antigüedad (tiempo desde la creación)
- Tiempo inactivo (tiempo desde el último uso)
- Sesión/agente asociado

### `openclaw sandbox recreate`

Eliminar contenedores sandbox para forzar la recreación con imágenes/configuración actualizadas.

```bash
openclaw sandbox recreate --all                # Recrear todos los contenedores
openclaw sandbox recreate --session main       # Sesión específica
openclaw sandbox recreate --agent mybot        # Agente específico
openclaw sandbox recreate --browser            # Solo contenedores de navegador
openclaw sandbox recreate --all --force        # Omitir confirmación
```

**Opciones:**

- `--all`: Recrear todos los contenedores sandbox
- `--session <key>`: Recrear contenedor para sesión específica
- `--agent <id>`: Recrear contenedores para agente específico
- `--browser`: Solo recrear contenedores de navegador
- `--force`: Omitir confirmación

**Importante:** Los contenedores se recrean automáticamente cuando el agente se usa nuevamente.

## Casos de uso

### Después de actualizar imágenes Docker

```bash
# Descargar nueva imagen
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Actualizar configuración para usar nueva imagen
# Editar configuración: agents.defaults.sandbox.docker.image (o agents.list[].sandbox.docker.image)

# Recrear contenedores
openclaw sandbox recreate --all
```

### Después de cambiar la configuración de sandbox

```bash
# Editar configuración: agents.defaults.sandbox.* (o agents.list[].sandbox.*)

# Recrear para aplicar nueva configuración
openclaw sandbox recreate --all
```

### Después de cambiar setupCommand

```bash
openclaw sandbox recreate --all
# o solo un agente:
openclaw sandbox recreate --agent family
```

### Solo para un agente específico

```bash
# Actualizar solo los contenedores de un agente
openclaw sandbox recreate --agent alfred
```

## ¿Por qué es necesario esto?

**Problema:** Cuando actualizas imágenes Docker de sandbox o configuración:

- Los contenedores existentes continúan ejecutándose con configuración antigua
- Los contenedores solo se eliminan después de 24h de inactividad
- Los agentes usados regularmente mantienen los contenedores antiguos ejecutándose indefinidamente

**Solución:** Usa `openclaw sandbox recreate` para forzar la eliminación de contenedores antiguos. Se recrearán automáticamente con la configuración actual cuando se necesiten nuevamente.

Consejo: prefiere `openclaw sandbox recreate` en lugar de `docker rm` manual. Utiliza el
sistema de nombres de contenedores del Gateway y evita desajustes cuando las claves de alcance/sesión cambian.

## Configuración

Las opciones de sandbox se encuentran en `~/.openclaw/openclaw.json` bajo `agents.defaults.sandbox` (las anulaciones por agente van en `agents.list[].sandbox`):

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... más opciones Docker
        },
        "prune": {
          "idleHours": 24, // Auto-eliminar después de 24h inactivo
          "maxAgeDays": 7, // Auto-eliminar después de 7 días
        },
      },
    },
  },
}
```

## Ver también

- [Documentación de Sandbox](/es-ES/gateway/sandboxing)
- [Configuración de Agentes](/es-ES/concepts/agent-workspace)
- [Comando Doctor](/es-ES/gateway/doctor) - Verificar configuración de sandbox
