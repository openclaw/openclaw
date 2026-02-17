---
summary: "Habilidades: gestionadas vs workspace, reglas de filtrado y cableado de config/env"
read_when:
  - Agregar o modificar habilidades
  - Cambiar el filtrado de habilidades o reglas de carga
title: "Habilidades"
---

# Habilidades (OpenClaw)

OpenClaw utiliza carpetas de habilidades compatibles con **[AgentSkills](https://agentskills.io)** para enseñar al agente cómo usar herramientas. Cada habilidad es un directorio que contiene un `SKILL.md` con frontmatter YAML e instrucciones. OpenClaw carga **habilidades empaquetadas** más anulaciones locales opcionales, y las filtra al momento de carga basándose en entorno, configuración y presencia de binarios.

## Ubicaciones y precedencia

Las habilidades se cargan desde **tres** lugares:

1. **Habilidades empaquetadas**: enviadas con la instalación (paquete npm u OpenClaw.app)
2. **Habilidades gestionadas/locales**: `~/.openclaw/skills`
3. **Habilidades de workspace**: `<workspace>/skills`

Si hay conflicto de nombre de habilidad, la precedencia es:

`<workspace>/skills` (más alta) → `~/.openclaw/skills` → habilidades empaquetadas (más baja)

Adicionalmente, puedes configurar carpetas de habilidades extra (precedencia más baja) vía
`skills.load.extraDirs` en `~/.openclaw/openclaw.json`.

## Habilidades por agente vs compartidas

En configuraciones **multi-agente**, cada agente tiene su propio workspace. Eso significa:

- **Habilidades por agente** viven en `<workspace>/skills` solo para ese agente.
- **Habilidades compartidas** viven en `~/.openclaw/skills` (gestionadas/locales) y son visibles
  para **todos los agentes** en la misma máquina.
- **Carpetas compartidas** también pueden agregarse vía `skills.load.extraDirs` (precedencia
  más baja) si quieres un paquete común de habilidades usado por múltiples agentes.

Si el mismo nombre de habilidad existe en más de un lugar, se aplica la precedencia usual:
workspace gana, luego gestionada/local, luego empaquetada.

## Plugins + habilidades

Los plugins pueden enviar sus propias habilidades listando directorios `skills` en
`openclaw.plugin.json` (rutas relativas a la raíz del plugin). Las habilidades de plugin se cargan
cuando el plugin está habilitado y participan en las reglas normales de precedencia de habilidades.
Puedes filtrarlas vía `metadata.openclaw.requires.config` en la entrada de configuración del plugin.
Consulta [Plugins](/es-ES/tools/plugin) para descubrimiento/configuración y [Herramientas](/es-ES/tools) para la
superficie de herramientas que esas habilidades enseñan.

## ClawHub (instalación + sincronización)

ClawHub es el registro público de habilidades para OpenClaw. Explora en
[https://clawhub.com](https://clawhub.com). Úsalo para descubrir, instalar, actualizar y respaldar habilidades.
Guía completa: [ClawHub](/es-ES/tools/clawhub).

Flujos comunes:

- Instalar una habilidad en tu workspace:
  - `clawhub install <skill-slug>`
- Actualizar todas las habilidades instaladas:
  - `clawhub update --all`
- Sincronizar (escanear + publicar actualizaciones):
  - `clawhub sync --all`

Por defecto, `clawhub` instala en `./skills` bajo tu directorio de trabajo actual (o recae en
el workspace de OpenClaw configurado). OpenClaw lo recoge como `<workspace>/skills` en la
próxima sesión.

## Notas de seguridad

- Trata las habilidades de terceros como **código no confiable**. Léelas antes de habilitarlas.
- Prefiere ejecuciones en sandbox para entradas no confiables y herramientas riesgosas. Consulta [Sandboxing](/es-ES/gateway/sandboxing).
- `skills.entries.*.env` y `skills.entries.*.apiKey` inyectan secretos en el proceso **host**
  para ese turno de agente (no el sandbox). Mantén los secretos fuera de prompts y logs.
- Para un modelo de amenazas más amplio y listas de verificación, consulta [Seguridad](/es-ES/gateway/security).

## Formato (compatible con AgentSkills + Pi)

`SKILL.md` debe incluir al menos:

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
---
```

Notas:

- Seguimos la especificación AgentSkills para diseño/intención.
- El parser usado por el agente embebido solo soporta claves de frontmatter de **una sola línea**.
- `metadata` debe ser un **objeto JSON de una sola línea**.
- Usa `{baseDir}` en instrucciones para referenciar la ruta de la carpeta de la habilidad.
- Claves de frontmatter opcionales:
  - `homepage` — URL mostrada como "Website" en la UI de Habilidades de macOS (también soportado vía `metadata.openclaw.homepage`).
  - `user-invocable` — `true|false` (predeterminado: `true`). Cuando es `true`, la habilidad se expone como un comando slash de usuario.
  - `disable-model-invocation` — `true|false` (predeterminado: `false`). Cuando es `true`, la habilidad se excluye del prompt del modelo (aún disponible vía invocación de usuario).
  - `command-dispatch` — `tool` (opcional). Cuando se establece a `tool`, el comando slash evita el modelo y despacha directamente a una herramienta.
  - `command-tool` — nombre de herramienta a invocar cuando `command-dispatch: tool` está establecido.
  - `command-arg-mode` — `raw` (predeterminado). Para despacho de herramienta, reenvía la cadena de args sin procesar a la herramienta (sin análisis del core).

    La herramienta se invoca con parámetros:
    `{ command: "<raw args>", commandName: "<slash command>", skillName: "<skill name>" }`.

## Filtrado (filtros al momento de carga)

OpenClaw **filtra habilidades al momento de carga** usando `metadata` (JSON de una línea):

```markdown
---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["uv"], "env": ["GEMINI_API_KEY"], "config": ["browser.enabled"] },
        "primaryEnv": "GEMINI_API_KEY",
      },
  }
---
```

Campos bajo `metadata.openclaw`:

- `always: true` — siempre incluir la habilidad (omitir otros filtros).
- `emoji` — emoji opcional usado por la UI de Habilidades de macOS.
- `homepage` — URL opcional mostrada como "Website" en la UI de Habilidades de macOS.
- `os` — lista opcional de plataformas (`darwin`, `linux`, `win32`). Si se establece, la habilidad solo es elegible en esos sistemas operativos.
- `requires.bins` — lista; cada uno debe existir en `PATH`.
- `requires.anyBins` — lista; al menos uno debe existir en `PATH`.
- `requires.env` — lista; la variable de entorno debe existir **o** estar provista en config.
- `requires.config` — lista de rutas de `openclaw.json` que deben ser truthy.
- `primaryEnv` — nombre de variable de entorno asociado con `skills.entries.<name>.apiKey`.
- `install` — array opcional de especificaciones de instalador usadas por la UI de Habilidades de macOS (brew/node/go/uv/download).

Nota sobre sandboxing:

- `requires.bins` se verifica en el **host** al momento de carga de habilidad.
- Si un agente está en sandbox, el binario también debe existir **dentro del contenedor**.
  Instálalo vía `agents.defaults.sandbox.docker.setupCommand` (o una imagen personalizada).
  `setupCommand` se ejecuta una vez después de crear el contenedor.
  Las instalaciones de paquetes también requieren egreso de red, un FS raíz escribible y un usuario root en el sandbox.
  Ejemplo: la habilidad `summarize` (`skills/summarize/SKILL.md`) necesita el CLI `summarize`
  en el contenedor sandbox para ejecutarse allí.

Ejemplo de instalador:

```markdown
---
name: gemini
description: Use Gemini CLI for coding assistance and Google search lookups.
metadata:
  {
    "openclaw":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---
```

Notas:

- Si se listan múltiples instaladores, el gateway elige una **única** opción preferida (brew cuando está disponible, de lo contrario node).
- Si todos los instaladores son `download`, OpenClaw lista cada entrada para que puedas ver los artefactos disponibles.
- Las especificaciones de instalador pueden incluir `os: ["darwin"|"linux"|"win32"]` para filtrar opciones por plataforma.
- Las instalaciones Node respetan `skills.install.nodeManager` en `openclaw.json` (predeterminado: npm; opciones: npm/pnpm/yarn/bun).
  Esto solo afecta **instalaciones de habilidades**; el runtime del Gateway debe seguir siendo Node
  (Bun no se recomienda para WhatsApp/Telegram).
- Instalaciones Go: si `go` falta y `brew` está disponible, el gateway instala Go vía Homebrew primero y establece `GOBIN` al `bin` de Homebrew cuando es posible.
- Instalaciones de descarga: `url` (requerido), `archive` (`tar.gz` | `tar.bz2` | `zip`), `extract` (predeterminado: auto cuando se detecta archivo), `stripComponents`, `targetDir` (predeterminado: `~/.openclaw/tools/<skillKey>`).

Si no hay `metadata.openclaw` presente, la habilidad siempre es elegible (a menos que
esté deshabilitada en config o bloqueada por `skills.allowBundled` para habilidades empaquetadas).

## Anulaciones de configuración (`~/.openclaw/openclaw.json`)

Las habilidades empaquetadas/gestionadas pueden alternarse y proporcionarse con valores de env:

```json5
{
  skills: {
    entries: {
      "nano-banana-pro": {
        enabled: true,
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
        config: {
          endpoint: "https://example.invalid",
          model: "nano-pro",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

Nota: si el nombre de la habilidad contiene guiones, cita la clave (JSON5 permite claves citadas).

Las claves de configuración coinciden con el **nombre de habilidad** por defecto. Si una habilidad define
`metadata.openclaw.skillKey`, usa esa clave bajo `skills.entries`.

Reglas:

- `enabled: false` deshabilita la habilidad incluso si está empaquetada/instalada.
- `env`: inyectado **solo si** la variable no está ya establecida en el proceso.
- `apiKey`: conveniencia para habilidades que declaran `metadata.openclaw.primaryEnv`.
- `config`: bolsa opcional para campos personalizados por habilidad; las claves personalizadas deben vivir aquí.
- `allowBundled`: lista de permitidos opcional solo para habilidades **empaquetadas**. Si se establece, solo
  las habilidades empaquetadas en la lista son elegibles (habilidades gestionadas/workspace no afectadas).

## Inyección de entorno (por ejecución de agente)

Cuando inicia una ejecución de agente, OpenClaw:

1. Lee metadatos de habilidad.
2. Aplica cualquier `skills.entries.<key>.env` o `skills.entries.<key>.apiKey` a
   `process.env`.
3. Construye el prompt del sistema con habilidades **elegibles**.
4. Restaura el entorno original después de que termina la ejecución.

Esto está **limitado a la ejecución del agente**, no a un entorno de shell global.

## Snapshot de sesión (rendimiento)

OpenClaw toma un snapshot de las habilidades elegibles **cuando inicia una sesión** y reutiliza esa lista para turnos subsecuentes en la misma sesión. Los cambios a habilidades o configuración toman efecto en la próxima sesión nueva.

Las habilidades también pueden refrescarse a mitad de sesión cuando el observador de habilidades está habilitado o cuando aparece un nuevo nodo remoto elegible (ver abajo). Piensa en esto como una **recarga en caliente**: la lista refrescada se recoge en el próximo turno de agente.

## Nodos macOS remotos (Gateway Linux)

Si el Gateway está ejecutándose en Linux pero un **nodo macOS** está conectado **con `system.run` permitido** (las aprobaciones de Exec en seguridad no están establecidas a `deny`), OpenClaw puede tratar habilidades exclusivas de macOS como elegibles cuando los binarios requeridos están presentes en ese nodo. El agente debe ejecutar esas habilidades vía la herramienta `nodes` (típicamente `nodes.run`).

Esto depende de que el nodo reporte su soporte de comandos y de una prueba de bin vía `system.run`. Si el nodo macOS se desconecta más tarde, las habilidades permanecen visibles; las invocaciones pueden fallar hasta que el nodo se reconecte.

## Observador de habilidades (auto-refresco)

Por defecto, OpenClaw observa carpetas de habilidades y actualiza el snapshot de habilidades cuando los archivos `SKILL.md` cambian. Configura esto bajo `skills.load`:

```json5
{
  skills: {
    load: {
      watch: true,
      watchDebounceMs: 250,
    },
  },
}
```

## Impacto de tokens (lista de habilidades)

Cuando las habilidades son elegibles, OpenClaw inyecta una lista XML compacta de habilidades disponibles en el prompt del sistema (vía `formatSkillsForPrompt` en `pi-coding-agent`). El costo es determinístico:

- **Sobrecarga base (solo cuando ≥1 habilidad):** 195 caracteres.
- **Por habilidad:** 97 caracteres + la longitud de los valores escapados XML de `<name>`, `<description>` y `<location>`.

Fórmula (caracteres):

```
total = 195 + Σ (97 + len(name_escaped) + len(description_escaped) + len(location_escaped))
```

Notas:

- El escape XML expande `& < > " '` en entidades (`&amp;`, `&lt;`, etc.), aumentando la longitud.
- Los conteos de tokens varían según el tokenizador del modelo. Una estimación aproximada estilo OpenAI es ~4 chars/token, así que **97 chars ≈ 24 tokens** por habilidad más las longitudes reales de tus campos.

## Ciclo de vida de habilidades gestionadas

OpenClaw envía un conjunto base de habilidades como **habilidades empaquetadas** como parte de la
instalación (paquete npm u OpenClaw.app). `~/.openclaw/skills` existe para
anulaciones locales (por ejemplo, fijar/parchear una habilidad sin cambiar la copia
empaquetada). Las habilidades de workspace son propiedad del usuario y anulan ambas en conflictos de nombre.

## Referencia de configuración

Consulta [Configuración de habilidades](/es-ES/tools/skills-config) para el esquema de configuración completo.

## ¿Buscas más habilidades?

Explora [https://clawhub.com](https://clawhub.com).

---
