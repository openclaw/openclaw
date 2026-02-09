---
summary: "Referencia de la CLI para `openclaw models` (status/list/set/scan, alias, fallbacks, auth)"
read_when:
  - Desea cambiar los modelos predeterminados o ver el estado de autenticación del proveedor
  - Desea escanear los modelos/proveedores disponibles y depurar perfiles de autenticación
title: "models"
---

# `openclaw models`

Descubrimiento, escaneo y configuración de modelos (modelo predeterminado, fallbacks, perfiles de autenticación).

Relacionado:

- Proveedores + modelos: [Models](/providers/models)
- Configuración de autenticación del proveedor: [Getting started](/start/getting-started)

## Comandos comunes

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` muestra el valor resuelto del predeterminado/fallbacks además de un resumen de autenticación.
Cuando hay disponibles instantáneas de uso del proveedor, la sección de estado de OAuth/token incluye
encabezados de uso del proveedor.
Agregue `--probe` para ejecutar sondas de autenticación en vivo contra cada perfil de proveedor configurado.
Las sondas son solicitudes reales (pueden consumir tokens y activar límites de tasa).
Use `--agent <id>` para inspeccionar el estado de modelo/autenticación de un agente configurado. Cuando se omite,
el comando usa `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` si están configurados; de lo contrario,
el agente predeterminado configurado.

Notas:

- `models set <model-or-alias>` acepta `provider/model` o un alias.
- Las referencias de modelos se analizan dividiendo por el **primer** `/`. Si el ID del modelo incluye `/` (estilo OpenRouter), incluya el prefijo del proveedor (ejemplo: `openrouter/moonshotai/kimi-k2`).
- Si omite el proveedor, OpenClaw trata la entrada como un alias o un modelo del **proveedor predeterminado** (solo funciona cuando no hay `/` en el ID del modelo).

### `models status`

Opciones:

- `--json`
- `--plain`
- `--check` (salida 1=expirado/faltante, 2=por expirar)
- `--probe` (sonda en vivo de perfiles de autenticación configurados)
- `--probe-provider <name>` (sondear un proveedor)
- `--probe-profile <id>` (repetir o IDs de perfil separados por comas)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (ID de agente configurado; sobrescribe `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Aliases + fallbacks

```bash
openclaw models aliases list
openclaw models fallbacks list
```

## Perfiles de autenticación

```bash
openclaw models auth add
openclaw models auth login --provider <id>
openclaw models auth setup-token
openclaw models auth paste-token
```

`models auth login` ejecuta el flujo de autenticación de un plugin de proveedor (OAuth/clave de API). Use
`openclaw plugins list` para ver qué proveedores están instalados.

Notas:

- `setup-token` solicita un valor de token de configuración (genérelo con `claude setup-token` en cualquier máquina).
- `paste-token` acepta una cadena de token generada en otro lugar o desde automatización.
