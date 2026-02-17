---
summary: "OpenProse: flujos de trabajo .prose, comandos slash y estado en OpenClaw"
read_when:
  - Quieres ejecutar o escribir flujos de trabajo .prose
  - Quieres habilitar el plugin OpenProse
  - Necesitas entender el almacenamiento de estado
title: "OpenProse"
---

# OpenProse

OpenProse es un formato de flujo de trabajo portable y basado en markdown para orquestar sesiones de IA. En OpenClaw se distribuye como un plugin que instala un paquete de habilidades de OpenProse más un comando slash `/prose`. Los programas residen en archivos `.prose` y pueden generar múltiples sub-agentes con control de flujo explícito.

Sitio oficial: [https://www.prose.md](https://www.prose.md)

## Qué puede hacer

- Investigación y síntesis multi-agente con paralelismo explícito.
- Flujos de trabajo repetibles y seguros para aprobación (revisión de código, triaje de incidentes, pipelines de contenido).
- Programas `.prose` reutilizables que puedes ejecutar en tiempos de ejecución de agentes compatibles.

## Instalación y habilitación

Los plugins incluidos están deshabilitados por defecto. Habilita OpenProse:

```bash
openclaw plugins enable open-prose
```

Reinicia el Gateway después de habilitar el plugin.

Desarrollo/repositorio local: `openclaw plugins install ./extensions/open-prose`

Documentos relacionados: [Plugins](/es-ES/tools/plugin), [Manifiesto de plugins](/es-ES/plugins/manifest), [Habilidades](/es-ES/tools/skills).

## Comando slash

OpenProse registra `/prose` como un comando de habilidad invocable por el usuario. Enruta a las instrucciones de la VM de OpenProse y usa herramientas de OpenClaw bajo el capó.

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
# Investigación + síntesis con dos agentes ejecutándose en paralelo.

input topic: "¿Qué deberíamos investigar?"

agent researcher:
  model: sonnet
  prompt: "Investigas exhaustivamente y citas fuentes."

agent writer:
  model: opus
  prompt: "Escribes un resumen conciso."

parallel:
  findings = session: researcher
    prompt: "Investiga {topic}."
  draft = session: writer
    prompt: "Resume {topic}."

session "Fusiona los hallazgos + borrador en una respuesta final."
context: { findings, draft }
```

## Ubicaciones de archivos

OpenProse mantiene el estado bajo `.prose/` en tu espacio de trabajo:

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

Los agentes persistentes a nivel de usuario residen en:

```
~/.prose/agents/
```

## Modos de estado

OpenProse soporta múltiples backends de estado:

- **filesystem** (predeterminado): `.prose/runs/...`
- **in-context**: transitorio, para programas pequeños
- **sqlite** (experimental): requiere el binario `sqlite3`
- **postgres** (experimental): requiere `psql` y una cadena de conexión

Notas:

- sqlite/postgres son opcionales y experimentales.
- Las credenciales de postgres fluyen hacia los registros de subagentes; usa una base de datos dedicada con privilegios mínimos.

## Programas remotos

`/prose run <handle/slug>` resuelve a `https://p.prose.md/<handle>/<slug>`.
Las URL directas se obtienen tal cual. Esto usa la herramienta `web_fetch` (o `exec` para POST).

## Mapeo de runtime de OpenClaw

Los programas OpenProse se mapean a primitivas de OpenClaw:

| Concepto de OpenProse         | Herramienta de OpenClaw |
| ----------------------------- | ----------------------- |
| Generar sesión / herramienta Task | `sessions_spawn`    |
| Lectura/escritura de archivos | `read` / `write`       |
| Obtención web                 | `web_fetch`             |

Si tu lista permitida de herramientas bloquea estas herramientas, los programas de OpenProse fallarán. Ver [Configuración de Habilidades](/es-ES/tools/skills-config).

## Seguridad y aprobaciones

Trata los archivos `.prose` como código. Revísalos antes de ejecutarlos. Usa listas permitidas de herramientas de OpenClaw y puertas de aprobación para controlar efectos secundarios.

Para flujos de trabajo determinísticos con puertas de aprobación, compara con [Lobster](/es-ES/tools/lobster).
