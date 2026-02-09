---
summary: "OpenProse: flujos de trabajo .prose, comandos de barra y estado en OpenClaw"
read_when:
  - Quiere ejecutar o escribir flujos de trabajo .prose
  - Quiere habilitar el plugin OpenProse
  - Necesita comprender el almacenamiento de estado
title: "OpenProse"
---

# OpenProse

OpenProse es un formato de flujo de trabajo portátil, _markdown-first_, para orquestar sesiones de IA. En OpenClaw se distribuye como un plugin que instala un paquete de Skills de OpenProse más un comando de barra `/prose`. Los programas viven en archivos `.prose` y pueden generar múltiples subagentes con control de flujo explícito.

Sitio oficial: [https://www.prose.md](https://www.prose.md)

## Lo que puede hacer

- Investigación y síntesis multiagente con paralelismo explícito.
- Flujos de trabajo repetibles y seguros para aprobaciones (revisión de código, triaje de incidentes, pipelines de contenido).
- Programas `.prose` reutilizables que puede ejecutar en runtimes de agentes compatibles.

## Instalar + habilitar

Los plugins incluidos vienen deshabilitados por defecto. Habilite OpenProse:

```bash
openclaw plugins enable open-prose
```

Reinicie el Gateway después de habilitar el plugin.

Checkout de desarrollo/local: `openclaw plugins install ./extensions/open-prose`

Documentos relacionados: [Plugins](/tools/plugin), [Manifiesto de plugin](/plugins/manifest), [Skills](/tools/skills).

## Comando de barra

OpenProse registra `/prose` como un comando de Skills invocable por el usuario. Se enruta a las instrucciones de la VM de OpenProse y usa herramientas de OpenClaw por debajo.

Comandos comunes:

```
/prose help
/prose run <file.prose>
/prose run <handle/slug>
/prose run <https://example.com/file.prose>
/prose compile <file.prose>
/prose examples
/prose update
```

## Ejemplo: un archivo `.prose` simple

```prose
# Research + synthesis with two agents running in parallel.

input topic: "What should we research?"

agent researcher:
  model: sonnet
  prompt: "You research thoroughly and cite sources."

agent writer:
  model: opus
  prompt: "You write a concise summary."

parallel:
  findings = session: researcher
    prompt: "Research {topic}."
  draft = session: writer
    prompt: "Summarize {topic}."

session "Merge the findings + draft into a final answer."
context: { findings, draft }
```

## Ubicaciones de archivos

OpenProse mantiene el estado bajo `.prose/` en su espacio de trabajo:

```
.prose/
├── .env
├── runs/
│   └── {YYYYMMDD}-{HHMMSS}-{random}/
│       ├── program.prose
│       ├── state.md
│       ├── bindings/
│       └── agents/
└── agents/
```

Los agentes persistentes a nivel de usuario viven en:

```
~/.prose/agents/
```

## Modos de estado

OpenProse admite múltiples backends de estado:

- **filesystem** (predeterminado): `.prose/runs/...`
- **in-context**: transitorio, para programas pequeños
- **sqlite** (experimental): requiere el binario `sqlite3`
- **postgres** (experimental): requiere `psql` y una cadena de conexión

Notas:

- sqlite/postgres son opcionales y experimentales.
- Las credenciales de postgres fluyen a los logs de subagentes; use una base de datos dedicada con privilegios mínimos.

## Programas remotos

`/prose run <handle/slug>` se resuelve a `https://p.prose.md/<handle>/<slug>`.
Las URL directas se obtienen tal cual. Esto usa la herramienta `web_fetch` (o `exec` para POST).

## Mapeo de runtime de OpenClaw

Los programas de OpenProse se mapean a primitivas de OpenClaw:

| Concepto de OpenProse                 | Herramienta de OpenClaw |
| ------------------------------------- | ----------------------- |
| Iniciar sesión / Herramienta de tarea | `sessions_spawn`        |
| Lectura/escritura de archivos         | `read` / `write`        |
| Obtención web                         | `web_fetch`             |

Si su lista de permitidos de herramientas bloquea estas herramientas, los programas de OpenProse fallarán. Consulte [Configuración de Skills](/tools/skills-config).

## Seguridad + aprobaciones

Trate los archivos `.prose` como código. Revise antes de ejecutar. Use listas de permitidos de herramientas de OpenClaw y compuertas de aprobación para controlar efectos secundarios.

Para flujos de trabajo deterministas y con aprobación, compare con [Lobster](/tools/lobster).
