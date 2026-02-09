---
title: CLI de Sandbox
summary: "Administre contenedores sandbox y examine la política efectiva del sandbox"
read_when: "Usted está administrando contenedores sandbox o depurando el comportamiento de sandbox/política de herramientas."
status: active
---

# CLI de Sandbox

Administre contenedores sandbox basados en Docker para la ejecución aislada de agentes.

## Descripción general

OpenClaw puede ejecutar agentes en contenedores Docker aislados por seguridad. Los comandos `sandbox` le ayudan a administrar estos contenedores, especialmente después de actualizaciones o cambios de configuración.

## Comandos

### `openclaw sandbox explain`

Inspeccione el modo/alcance/acceso al espacio de trabajo **efectivo** del sandbox, la política de herramientas del sandbox y las puertas elevadas (con rutas de claves de configuración de corrección).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Enumere todos los contenedores sandbox con su estado y configuración.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**La salida incluye:**

- Nombre del contenedor y estado (en ejecución/detenido)
- Imagen de Docker y si coincide con la configuración
- Antigüedad (tiempo desde la creación)
- Tiempo inactivo (tiempo desde el último uso)
- Sesión/agente asociado

### `openclaw sandbox recreate`

Elimine contenedores sandbox para forzar su recreación con imágenes/configuración actualizadas.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Opciones:**

- `--all`: Recrear todos los contenedores sandbox
- `--session <key>`: Recrear el contenedor para una sesión específica
- `--agent <id>`: Recrear contenedores para un agente específico
- `--browser`: Recrear solo contenedores del navegador
- `--force`: Omitir el aviso de confirmación

**Importante:** Los contenedores se recrean automáticamente cuando el agente se usa la próxima vez.

## Casos de uso

### Después de actualizar imágenes de Docker

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Después de cambiar la configuración del sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Después de cambiar setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Solo para un agente específico

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## ¿Por qué es necesario?

**Problema:** Cuando usted actualiza imágenes de Docker del sandbox o la configuración:

- Los contenedores existentes continúan ejecutándose con configuraciones antiguas
- Los contenedores solo se depuran después de 24 h de inactividad
- Los agentes usados con regularidad mantienen contenedores antiguos ejecutándose indefinidamente

**Solución:** Use `openclaw sandbox recreate` para forzar la eliminación de contenedores antiguos. Se recrearán automáticamente con la configuración actual cuando se necesiten de nuevo.

Consejo: prefiera `openclaw sandbox recreate` en lugar de `docker rm` manual. Usa el
nomenclado de contenedores del Gateway y evita desajustes cuando cambian las claves de alcance/sesión.

## Configuración

La configuración del sandbox se encuentra en `~/.openclaw/openclaw.json` bajo `agents.defaults.sandbox` (las anulaciones por agente van en `agents.list[].sandbox`):

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
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Véase también

- [Documentación de Sandbox](/gateway/sandboxing)
- [Configuración del agente](/concepts/agent-workspace)
- [Comando Doctor](/gateway/doctor) - Verifique la configuración del sandbox
