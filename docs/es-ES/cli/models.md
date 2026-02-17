---
summary: "Referencia CLI para `openclaw models` (estado/listar/establecer/escanear, alias, respaldos, autenticación)"
read_when:
  - Quieres cambiar modelos predeterminados o ver el estado de autenticación del proveedor
  - Quieres escanear modelos/proveedores disponibles y depurar perfiles de autenticación
title: "models"
---

# `openclaw models`

Descubrimiento, escaneo y configuración de modelos (modelo predeterminado, respaldos, perfiles de autenticación).

Relacionado:

- Proveedores + modelos: [Modelos](/es-ES/providers/models)
- Configuración de autenticación de proveedor: [Primeros pasos](/es-ES/start/getting-started)

## Comandos comunes

```bash
openclaw models status
openclaw models list
openclaw models set <model-or-alias>
openclaw models scan
```

`openclaw models status` muestra los predeterminados/respaldos resueltos más un resumen de autenticación.
Cuando hay instantáneas de uso del proveedor disponibles, la sección de estado de OAuth/token incluye
encabezados de uso del proveedor.
Agrega `--probe` para ejecutar pruebas de autenticación en vivo contra cada perfil de proveedor configurado.
Las pruebas son solicitudes reales (pueden consumir tokens y activar límites de tasa).
Usa `--agent <id>` para inspeccionar el estado de modelo/autenticación de un agente configurado. Cuando se omite,
el comando usa `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR` si está establecido, de lo contrario el
agente predeterminado configurado.

Notas:

- `models set <model-or-alias>` acepta `provider/model` o un alias.
- Las referencias de modelo se analizan dividiendo en la **primera** `/`. Si el ID del modelo incluye `/` (estilo OpenRouter), incluye el prefijo del proveedor (ejemplo: `openrouter/moonshotai/kimi-k2`).
- Si omites el proveedor, OpenClaw trata la entrada como un alias o un modelo para el **proveedor predeterminado** (solo funciona cuando no hay `/` en el ID del modelo).

### `models status`

Opciones:

- `--json`
- `--plain`
- `--check` (salida 1=expirado/faltante, 2=expirando)
- `--probe` (prueba en vivo de perfiles de autenticación configurados)
- `--probe-provider <name>` (probar un proveedor)
- `--probe-profile <id>` (repetir o ids de perfil separados por comas)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`
- `--agent <id>` (id de agente configurado; sobrescribe `OPENCLAW_AGENT_DIR`/`PI_CODING_AGENT_DIR`)

## Alias + respaldos

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

`models auth login` ejecuta el flujo de autenticación de un plugin de proveedor (OAuth/Clave de API). Usa
`openclaw plugins list` para ver qué proveedores están instalados.

Notas:

- `setup-token` solicita un valor de setup-token (genéralo con `claude setup-token` en cualquier máquina).
- `paste-token` acepta una cadena de token generada en otro lugar o desde automatización.
