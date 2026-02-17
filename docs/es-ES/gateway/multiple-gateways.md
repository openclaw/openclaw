---
summary: "Ejecuta múltiples Gateways de OpenClaw en un host (aislamiento, puertos y perfiles)"
read_when:
  - Ejecutando más de un Gateway en la misma máquina
  - Necesitas config/estado/puertos aislados por Gateway
title: "Múltiples Gateways"
---

# Múltiples Gateways (mismo host)

La mayoría de las configuraciones deben usar un Gateway porque un solo Gateway puede manejar múltiples conexiones de mensajería y agentes. Si necesitas mayor aislamiento o redundancia (ej., un bot de rescate), ejecuta Gateways separados con perfiles/puertos aislados.

## Lista de verificación de aislamiento (requerido)

- `OPENCLAW_CONFIG_PATH` — archivo de configuración por instancia
- `OPENCLAW_STATE_DIR` — sesiones, credenciales, cachés por instancia
- `agents.defaults.workspace` — raíz del espacio de trabajo por instancia
- `gateway.port` (o `--port`) — único por instancia
- Los puertos derivados (browser/canvas) no deben superponerse

Si estos se comparten, encontrarás conflictos de configuración y puertos.

## Recomendado: perfiles (`--profile`)

Los perfiles auto-delimitan `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` y añaden sufijos a los nombres de servicios.

```bash
# principal
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescate
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Servicios por perfil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Guía de bot de rescate

Ejecuta un segundo Gateway en el mismo host con su propio:

- perfil/config
- directorio de estado
- espacio de trabajo
- puerto base (más puertos derivados)

Esto mantiene al bot de rescate aislado del bot principal para que pueda depurar o aplicar cambios de configuración si el bot principal está inactivo.

Espaciado de puertos: deja al menos 20 puertos entre puertos base para que los puertos derivados de browser/canvas/CDP nunca colisionen.

### Cómo instalar (bot de rescate)

```bash
# Bot principal (existente o nuevo, sin parámetro --profile)
# Se ejecuta en puerto 18789 + Puertos Chrome CDC/Canvas/...
openclaw onboard
openclaw gateway install

# Bot de rescate (perfil aislado + puertos)
openclaw --profile rescue onboard
# Notas:
# - el nombre del espacio de trabajo tendrá el sufijo -rescue por defecto
# - El puerto debe ser al menos 18789 + 20 Puertos,
#   mejor elige un puerto base completamente diferente, como 19789,
# - el resto de la incorporación es igual que la normal

# Para instalar el servicio (si no sucedió automáticamente durante la incorporación)
openclaw --profile rescue gateway install
```

## Mapeo de puertos (derivados)

Puerto base = `gateway.port` (o `OPENCLAW_GATEWAY_PORT` / `--port`).

- puerto del servicio de control del navegador = base + 2 (solo bucle local)
- el host del canvas se sirve en el servidor HTTP del Gateway (mismo puerto que `gateway.port`)
- Los puertos CDP del perfil del navegador se auto-asignan desde `browser.controlPort + 9 .. + 108`

Si anulas cualquiera de estos en config o env, debes mantenerlos únicos por instancia.

## Notas sobre Browser/CDP (error común)

- **No** fije `browser.cdpUrl` a los mismos valores en múltiples instancias.
- Cada instancia necesita su propio puerto de control del navegador y rango CDP (derivado de su puerto gateway).
- Si necesitas puertos CDP explícitos, establece `browser.profiles.<name>.cdpPort` por instancia.
- Chrome remoto: usa `browser.profiles.<name>.cdpUrl` (por perfil, por instancia).

## Ejemplo de env manual

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Verificaciones rápidas

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
