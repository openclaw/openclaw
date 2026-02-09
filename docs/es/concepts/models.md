---
summary: "CLI de modelos: listar, establecer, alias, alternativas, escanear, estado"
read_when:
  - Agregar o modificar la CLI de modelos (models list/set/scan/aliases/fallbacks)
  - Cambiar el comportamiento de alternativas de modelos o la UX de selección
  - Actualizar sondeos de escaneo de modelos (herramientas/imágenes)
title: "CLI de modelos"
---

# CLI de modelos

Vea [/concepts/model-failover](/concepts/model-failover) para la rotación de perfiles de autenticación,
los enfriamientos y cómo eso interactúa con las alternativas.
Resumen rápido de proveedores + ejemplos: [/concepts/model-providers](/concepts/model-providers).

## Cómo funciona la selección de modelos

OpenClaw selecciona modelos en este orden:

1. **Primario** (`agents.defaults.model.primary` o `agents.defaults.model`).
2. **Alternativas** en `agents.defaults.model.fallbacks` (en orden).
3. **Conmutación por error de autenticación del proveedor** ocurre dentro de un proveedor antes de pasar al
   siguiente modelo.

Relacionado:

- `agents.defaults.models` es la lista de permitidos/catálogo de modelos que OpenClaw puede usar (más alias).
- `agents.defaults.imageModel` se usa **solo cuando** el modelo primario no puede aceptar imágenes.
- Los valores predeterminados por agente pueden sobrescribir `agents.defaults.model` mediante `agents.list[].model` más enlaces (ver [/concepts/multi-agent](/concepts/multi-agent)).

## Selecciones rápidas de modelos (anecdóticas)

- **GLM**: un poco mejor para programación/llamadas a herramientas.
- **MiniMax**: mejor para redacción y estilo.

## Asistente de configuración (recomendado)

Si no desea editar la configuración a mano, ejecute el asistente de incorporación:

```bash
openclaw onboard
```

Puede configurar modelo + autenticación para proveedores comunes, incluidos **OpenAI Code (Codex)
subscription** (OAuth) y **Anthropic** (se recomienda clave de API; `claude
setup-token` también es compatible).

## Claves de configuración (resumen)

- `agents.defaults.model.primary` y `agents.defaults.model.fallbacks`
- `agents.defaults.imageModel.primary` y `agents.defaults.imageModel.fallbacks`
- `agents.defaults.models` (lista de permitidos + alias + parámetros del proveedor)
- `models.providers` (proveedores personalizados escritos en `models.json`)

Las referencias de modelos se normalizan a minúsculas. Los alias de proveedores como `z.ai/*` se normalizan
a `zai/*`.

Los ejemplos de configuración de proveedores (incluido OpenCode Zen) están en
[/gateway/configuration](/gateway/configuration#opencode-zen-multi-model-proxy).

## “El modelo no está permitido” (y por qué las respuestas se detienen)

Si `agents.defaults.models` está configurado, se convierte en la **lista de permitidos** para `/model` y para
sobrescrituras de sesión. Cuando un usuario selecciona un modelo que no está en esa lista,
OpenClaw devuelve:

```
Model "provider/model" is not allowed. Use /model to list available models.
```

Esto ocurre **antes** de que se genere una respuesta normal, por lo que el mensaje puede sentirse
como si “no respondiera”. La solución es:

- Agregar el modelo a `agents.defaults.models`, o
- Limpiar la lista de permitidos (eliminar `agents.defaults.models`), o
- Elegir un modelo de `/model list`.

Ejemplo de configuración de lista de permitidos:

```json5
{
  agent: {
    model: { primary: "anthropic/claude-sonnet-4-5" },
    models: {
      "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
      "anthropic/claude-opus-4-6": { alias: "Opus" },
    },
  },
}
```

## Cambiar modelos en el chat (`/model`)

Puede cambiar modelos para la sesión actual sin reiniciar:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model status
```

Notas:

- `/model` (y `/model list`) es un selector compacto y numerado (familia de modelos + proveedores disponibles).
- `/model <#>` selecciona desde ese selector.
- `/model status` es la vista detallada (candidatos de autenticación y, cuando está configurado, el endpoint del proveedor `baseUrl` + el modo `api`).
- Las referencias de modelos se analizan separando por el **primer** `/`. Use `provider/model` al escribir `/model <ref>`.
- Si el ID del modelo en sí contiene `/` (estilo OpenRouter), debe incluir el prefijo del proveedor (ejemplo: `/model openrouter/moonshotai/kimi-k2`).
- Si omite el proveedor, OpenClaw trata la entrada como un alias o un modelo para el **proveedor predeterminado** (solo funciona cuando no hay `/` en el ID del modelo).

Comportamiento/configuración completa del comando: [Slash commands](/tools/slash-commands).

## Comandos de la CLI

```bash
openclaw models list
openclaw models status
openclaw models set <provider/model>
openclaw models set-image <provider/model>

openclaw models aliases list
openclaw models aliases add <alias> <provider/model>
openclaw models aliases remove <alias>

openclaw models fallbacks list
openclaw models fallbacks add <provider/model>
openclaw models fallbacks remove <provider/model>
openclaw models fallbacks clear

openclaw models image-fallbacks list
openclaw models image-fallbacks add <provider/model>
openclaw models image-fallbacks remove <provider/model>
openclaw models image-fallbacks clear
```

`openclaw models` (sin subcomando) es un atajo para `models status`.

### `models list`

Muestra los modelos configurados de forma predeterminada. Indicadores útiles:

- `--all`: catálogo completo
- `--local`: solo proveedores locales
- `--provider <name>`: filtrar por proveedor
- `--plain`: un modelo por línea
- `--json`: salida legible por máquinas

### `models status`

Muestra el modelo primario resuelto, las alternativas, el modelo de imágenes y un resumen de autenticación
de los proveedores configurados. También muestra el estado de caducidad de OAuth para los perfiles encontrados
en el almacén de autenticación (advierte dentro de 24 h de forma predeterminada). `--plain` imprime solo el
modelo primario resuelto.
El estado de OAuth siempre se muestra (y se incluye en la salida de `--json`). Si un proveedor configurado
no tiene credenciales, `models status` imprime una sección **Missing auth**.
El JSON incluye `auth.oauth` (ventana de advertencia + perfiles) y `auth.providers`
(autenticación efectiva por proveedor).
Use `--check` para automatización (salida `1` cuando falta/está vencida, `2` cuando está por vencer).

La autenticación preferida de Anthropic es el setup-token de la CLI de Claude Code (ejecútelo en cualquier lugar; péguelo en el host del Gateway si es necesario):

```bash
claude setup-token
openclaw models status
```

## Escaneo (modelos gratuitos de OpenRouter)

`openclaw models scan` inspecciona el **catálogo de modelos gratuitos** de OpenRouter y puede
opcionalmente sondear modelos para soporte de herramientas e imágenes.

Indicadores clave:

- `--no-probe`: omitir sondeos en vivo (solo metadatos)
- `--min-params <b>`: tamaño mínimo de parámetros (miles de millones)
- `--max-age-days <days>`: omitir modelos antiguos
- `--provider <name>`: filtro de prefijo de proveedor
- `--max-candidates <n>`: tamaño de la lista de alternativas
- `--set-default`: establecer `agents.defaults.model.primary` en la primera selección
- `--set-image`: establecer `agents.defaults.imageModel.primary` en la primera selección de imágenes

El sondeo requiere una clave de API de OpenRouter (desde perfiles de autenticación o
`OPENROUTER_API_KEY`). Sin una clave, use `--no-probe` para listar solo candidatos.

Los resultados del escaneo se clasifican por:

1. Soporte de imágenes
2. Latencia de herramientas
3. Tamaño de contexto
4. Recuento de parámetros

Entrada

- Lista `/models` de OpenRouter (filtro `:free`)
- Requiere clave de API de OpenRouter desde perfiles de autenticación o `OPENROUTER_API_KEY` (ver [/environment](/help/environment))
- Filtros opcionales: `--max-age-days`, `--min-params`, `--provider`, `--max-candidates`
- Controles de sondeo: `--timeout`, `--concurrency`

Cuando se ejecuta en un TTY, puede seleccionar alternativas de forma interactiva. En modo no interactivo,
pase `--yes` para aceptar los valores predeterminados.

## Registro de modelos (`models.json`)

Los proveedores personalizados en `models.providers` se escriben en `models.json` bajo el
directorio del agente (predeterminado `~/.openclaw/agents/<agentId>/models.json`). Este archivo
se fusiona de forma predeterminada a menos que `models.mode` esté configurado en `replace`.
