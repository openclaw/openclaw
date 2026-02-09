---
summary: "Use MiniMax M2.1 en OpenClaw"
read_when:
  - Quiere modelos MiniMax en OpenClaw
  - Necesita orientación para configurar MiniMax
title: "MiniMax"
---

# MiniMax

MiniMax es una empresa de IA que desarrolla la familia de modelos **M2/M2.1**. La versión
actual enfocada en programación es **MiniMax M2.1** (23 de diciembre de 2025), creada para
tareas complejas del mundo real.

Fuente: [Nota de lanzamiento de MiniMax M2.1](https://www.minimax.io/news/minimax-m21)

## Descripción general del modelo (M2.1)

MiniMax destaca estas mejoras en M2.1:

- **Programación multilenguaje** más sólida (Rust, Java, Go, C++, Kotlin, Objective-C, TS/JS).
- Mejor **desarrollo web/app** y calidad estética de las salidas (incluido móvil nativo).
- Manejo mejorado de **instrucciones compuestas** para flujos de trabajo de tipo oficina, basado en
  pensamiento intercalado y ejecución integrada de restricciones.
- **Respuestas más concisas** con menor uso de tokens y ciclos de iteración más rápidos.
- Mayor compatibilidad con **frameworks de herramientas/agentes** y gestión de contexto (Claude Code,
  Droid/Factory AI, Cline, Kilo Code, Roo Code, BlackBox).
- Salidas de **diálogo y redacción técnica** de mayor calidad.

## MiniMax M2.1 vs MiniMax M2.1 Lightning

- **Velocidad:** Lightning es la variante “rápida” en la documentación de precios de MiniMax.
- **Costo:** Los precios muestran el mismo costo de entrada, pero Lightning tiene un costo de salida más alto.
- **Enrutamiento del plan de programación:** El back-end Lightning no está disponible directamente en el plan de programación de MiniMax. MiniMax enruta automáticamente la mayoría de las solicitudes a Lightning, pero vuelve al back-end regular de M2.1 durante picos de tráfico.

## Elegir una configuración

### MiniMax OAuth (Plan de Programación) — recomendado

**Mejor para:** configuración rápida con el Plan de Programación de MiniMax mediante OAuth, no se requiere clave de API.

Habilite el plugin OAuth incluido y autentíquese:

```bash
openclaw plugins enable minimax-portal-auth  # skip if already loaded.
openclaw gateway restart  # restart if gateway is already running
openclaw onboard --auth-choice minimax-portal
```

Se le pedirá que seleccione un endpoint:

- **Global** - Usuarios internacionales (`api.minimax.io`)
- **CN** - Usuarios en China (`api.minimaxi.com`)

Consulte el [README del plugin MiniMax OAuth](https://github.com/openclaw/openclaw/tree/main/extensions/minimax-portal-auth) para más detalles.

### MiniMax M2.1 (clave de API)

**Mejor para:** MiniMax alojado con API compatible con Anthropic.

Configure mediante la CLI:

- Ejecute `openclaw configure`
- Seleccione **Model/auth**
- Elija **MiniMax M2.1**

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### MiniMax M2.1 como respaldo (Opus primario)

**Mejor para:** mantener Opus 4.6 como primario y conmutar por error a MiniMax M2.1.

```json5
{
  env: { MINIMAX_API_KEY: "sk-..." },
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

### Opcional: Local vía LM Studio (manual)

**Mejor para:** inferencia local con LM Studio.
Hemos visto resultados sólidos con MiniMax M2.1 en hardware potente (por ejemplo,
una computadora de escritorio/servidor) usando el servidor local de LM Studio.

Configure manualmente mediante `openclaw.json`:

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: { "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Configurar mediante `openclaw configure`

Use el asistente de configuración interactivo para establecer MiniMax sin editar JSON:

1. Ejecute `openclaw configure`.
2. Seleccione **Model/auth**.
3. Elija **MiniMax M2.1**.
4. Seleccione su modelo predeterminado cuando se le solicite.

## Opciones de configuración

- `models.providers.minimax.baseUrl`: prefiera `https://api.minimax.io/anthropic` (compatible con Anthropic); `https://api.minimax.io/v1` es opcional para cargas útiles compatibles con OpenAI.
- `models.providers.minimax.api`: prefiera `anthropic-messages`; `openai-completions` es opcional para cargas útiles compatibles con OpenAI.
- `models.providers.minimax.apiKey`: clave de API de MiniMax (`MINIMAX_API_KEY`).
- `models.providers.minimax.models`: defina `id`, `name`, `reasoning`, `contextWindow`, `maxTokens`, `cost`.
- `agents.defaults.models`: alias de modelos que desea en la lista de permitidos.
- `models.mode`: mantenga `merge` si desea agregar MiniMax junto a los integrados.

## Notas

- Las referencias de modelos son `minimax/<model>`.
- API de uso del Plan de Programación: `https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains` (requiere una clave del plan de programación).
- Actualice los valores de precios en `models.json` si necesita un seguimiento exacto de costos.
- Enlace de referencia para el Plan de Programación de MiniMax (10% de descuento): [https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link](https://platform.minimax.io/subscribe/coding-plan?code=DbXJTRClnb&source=link)
- Consulte [/concepts/model-providers](/concepts/model-providers) para las reglas de proveedores.
- Use `openclaw models list` y `openclaw models set minimax/MiniMax-M2.1` para cambiar.

## Solución de problemas

### “Unknown model: minimax/MiniMax-M2.1”

Esto normalmente significa que **el proveedor MiniMax no está configurado** (no hay una entrada de proveedor
y no se encontró un perfil de autenticación/env key de MiniMax). Una corrección para esta detección está en
**2026.1.12** (no publicado al momento de escribir). Solucione mediante:

- Actualizar a **2026.1.12** (o ejecutar desde el código fuente `main`), luego reiniciar el Gateway.
- Ejecutar `openclaw configure` y seleccionar **MiniMax M2.1**, o
- Agregar manualmente el bloque `models.providers.minimax`, o
- Establecer `MINIMAX_API_KEY` (o un perfil de autenticación de MiniMax) para que el proveedor pueda inyectarse.

Asegúrese de que el ID del modelo sea **sensible a mayúsculas y minúsculas**:

- `minimax/MiniMax-M2.1`
- `minimax/MiniMax-M2.1-lightning`

Luego vuelva a comprobar con:

```bash
openclaw models list
```
