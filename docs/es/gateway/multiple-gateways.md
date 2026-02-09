---
summary: "Ejecutar múltiples Gateways de OpenClaw en un solo host (aislamiento, puertos y perfiles)"
read_when:
  - Ejecutar más de un Gateway en la misma máquina
  - Necesita configuración/estado/puertos aislados por Gateway
title: "Múltiples Gateways"
---

# Múltiples Gateways (mismo host)

La mayoría de las configuraciones deberían usar un solo Gateway porque un único Gateway puede manejar múltiples conexiones de mensajería y agentes. Si necesita un aislamiento o redundancia más fuertes (p. ej., un bot de rescate), ejecute Gateways separados con perfiles/puertos aislados.

## Lista de verificación de aislamiento (obligatoria)

- `OPENCLAW_CONFIG_PATH` — archivo de configuración por instancia
- `OPENCLAW_STATE_DIR` — sesiones, credenciales y cachés por instancia
- `agents.defaults.workspace` — raíz del espacio de trabajo por instancia
- `gateway.port` (o `--port`) — único por instancia
- Los puertos derivados (navegador/canvas) no deben superponerse

Si estos se comparten, encontrará carreras de configuración y conflictos de puertos.

## Recomendado: perfiles (`--profile`)

Los perfiles delimitan automáticamente `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` y agregan un sufijo a los nombres de los servicios.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Servicios por perfil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guía de bot de rescate

Ejecute un segundo Gateway en el mismo host con sus propios:

- perfil/configuración
- directorio de estado
- espacio de trabajo
- puerto base (más puertos derivados)

Esto mantiene el bot de rescate aislado del bot principal para que pueda depurar o aplicar cambios de configuración si el bot principal está caído.

Separación de puertos: deje al menos 20 puertos entre los puertos base para que los puertos derivados de navegador/canvas/CDP nunca colisionen.

### Cómo instalar (bot de rescate)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Mapeo de puertos (derivados)

Puerto base = `gateway.port` (o `OPENCLAW_GATEWAY_PORT` / `--port`).

- puerto del servicio de control del navegador = base + 2 (solo loopback)
- `canvasHost.port = base + 4`
- Los puertos CDP del perfil del navegador se asignan automáticamente desde `browser.controlPort + 9 .. + 108`

Si sobrescribe cualquiera de estos en la configuración o en variables de entorno, debe mantenerlos únicos por instancia.

## Notas sobre Navegador/CDP (error común)

- **No** fije `browser.cdpUrl` a los mismos valores en múltiples instancias.
- Cada instancia necesita su propio puerto de control del navegador y su propio rango CDP (derivado de su puerto del Gateway).
- Si necesita puertos CDP explícitos, configure `browser.profiles.<name>.cdpPort` por instancia.
- Chrome remoto: use `browser.profiles.<name>.cdpUrl` (por perfil, por instancia).

## Ejemplo manual de env

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Comprobaciones rápidas

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
