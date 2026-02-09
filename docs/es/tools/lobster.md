---
title: Lobster
summary: "Runtime de flujos de trabajo tipado para OpenClaw con compuertas de aprobación reanudables."
description: Typed workflow runtime for OpenClaw — composable pipelines with approval gates.
read_when:
  - Quiere flujos de trabajo deterministas de varios pasos con aprobaciones explícitas
  - Necesita reanudar un flujo de trabajo sin volver a ejecutar pasos anteriores
---

# Lobster

Lobster es un shell de flujos de trabajo que permite a OpenClaw ejecutar secuencias de herramientas de varios pasos como una sola operación determinista con puntos de control de aprobación explícitos.

## Hook

Su asistente puede crear las herramientas que se gestionan a sí mismas. Pida un flujo de trabajo y, 30 minutos después, tendrá una CLI más pipelines que se ejecutan como una sola llamada. Lobster es la pieza que faltaba: pipelines deterministas, aprobaciones explícitas y estado reanudable.

## Por qué

Hoy, los flujos de trabajo complejos requieren muchas llamadas de herramientas de ida y vuelta. Cada llamada cuesta tokens y el LLM tiene que orquestar cada paso. Lobster traslada esa orquestación a un runtime tipado:

- **Una llamada en lugar de muchas**: OpenClaw ejecuta una llamada de herramienta de Lobster y obtiene un resultado estructurado.
- **Aprobaciones integradas**: Los efectos secundarios (enviar correo, publicar comentario) detienen el flujo de trabajo hasta que se aprueban explícitamente.
- **Reanudable**: Los flujos de trabajo detenidos devuelven un token; apruebe y reanude sin volver a ejecutar todo.

## ¿Por qué un DSL en lugar de programas simples?

Lobster es intencionalmente pequeño. El objetivo no es “un nuevo lenguaje”, sino una especificación de pipeline predecible y amigable para IA, con aprobaciones de primera clase y tokens de reanudación.

- **Aprobar/reanudar está integrado**: Un programa normal puede solicitar a un humano, pero no puede _pausar y reanudar_ con un token duradero sin que usted invente ese runtime por su cuenta.
- **Determinismo + auditabilidad**: Los pipelines son datos, por lo que es fácil registrarlos, compararlos, reproducirlos y revisarlos.
- **Superficie restringida para IA**: Una gramática pequeña + canalización JSON reduce rutas de código “creativas” y hace viable la validación.
- **Política de seguridad integrada**: Tiempos de espera, límites de salida, verificaciones de sandbox y listas de permitidos se aplican por el runtime, no por cada script.
- **Aún programable**: Cada paso puede llamar a cualquier CLI o script. Si quiere JS/TS, genere archivos `.lobster` desde código.

## Cómo funciona

OpenClaw inicia la CLI local `lobster` en **modo herramienta** y analiza un sobre JSON desde stdout.
Si el pipeline se pausa para aprobación, la herramienta devuelve un `resumeToken` para que pueda continuar más tarde.

## Patrón: CLI pequeña + pipes JSON + aprobaciones

Cree comandos pequeños que hablen JSON y luego encadénelos en una sola llamada de Lobster. (Nombres de comandos de ejemplo abajo — sustituya por los suyos.)

```bash
inbox list --json
inbox categorize --json
inbox apply --json
```

```json
{
  "action": "run",
  "pipeline": "exec --json --shell 'inbox list --json' | exec --stdin json --shell 'inbox categorize --json' | exec --stdin json --shell 'inbox apply --json' | approve --preview-from-stdin --limit 5 --prompt 'Apply changes?'",
  "timeoutMs": 30000
}
```

Si el pipeline solicita aprobación, reanude con el token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

La IA activa el flujo de trabajo; Lobster ejecuta los pasos. Las compuertas de aprobación mantienen los efectos secundarios explícitos y auditables.

Ejemplo: mapear elementos de entrada a llamadas de herramientas:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## Pasos de LLM solo JSON (llm-task)

Para flujos de trabajo que necesitan un **paso de LLM estructurado**, habilite la herramienta de plugin opcional
`llm-task` y llámela desde Lobster. Esto mantiene el flujo de trabajo
determinista mientras le permite clasificar/resumir/redactar con un modelo.

Habilite la herramienta:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

Úsela en un pipeline:

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": { "subject": "Hello", "body": "Can you help?" },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

Vea [LLM Task](/tools/llm-task) para detalles y opciones de configuración.

## Archivos de flujo de trabajo (.lobster)

Lobster puede ejecutar archivos de flujo de trabajo YAML/JSON con los campos `name`, `args`, `steps`, `env`, `condition` y `approval`. En llamadas de herramientas de OpenClaw, establezca `pipeline` en la ruta del archivo.

```yaml
name: inbox-triage
args:
  tag:
    default: "family"
steps:
  - id: collect
    command: inbox list --json
  - id: categorize
    command: inbox categorize --json
    stdin: $collect.stdout
  - id: approve
    command: inbox apply --approve
    stdin: $categorize.stdout
    approval: required
  - id: execute
    command: inbox apply --execute
    stdin: $categorize.stdout
    condition: $approve.approved
```

Notas:

- `stdin: $step.stdout` y `stdin: $step.json` pasan la salida de un paso previo.
- `condition` (o `when`) puede condicionar pasos en `$step.approved`.

## Instalar Lobster

Instale la CLI de Lobster en el **mismo host** que ejecuta el Gateway de OpenClaw (vea el [repo de Lobster](https://github.com/openclaw/lobster)) y asegúrese de que `lobster` esté en `PATH`.
Si desea usar una ubicación personalizada del binario, pase un `lobsterPath` **absoluto** en la llamada de la herramienta.

## Habilitar la herramienta

Lobster es una herramienta de plugin **opcional** (no habilitada por defecto).

Recomendado (aditivo, seguro):

```json
{
  "tools": {
    "alsoAllow": ["lobster"]
  }
}
```

O por agente:

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["lobster"]
        }
      }
    ]
  }
}
```

Evite usar `tools.allow: ["lobster"]` a menos que pretenda ejecutar en modo de lista de permitidos restrictiva.

Nota: las listas de permitidos son opt-in para plugins opcionales. Si su lista de permitidos solo nombra
herramientas de plugin (como `lobster`), OpenClaw mantiene habilitadas las herramientas principales. Para restringir
las herramientas principales, incluya también en la lista de permitidos las herramientas o grupos principales que desee.

## Ejemplo: triaje de correo electrónico

Sin Lobster:

```
User: "Check my email and draft replies"
→ openclaw calls gmail.list
→ LLM summarizes
→ User: "draft replies to #2 and #5"
→ LLM drafts
→ User: "send #2"
→ openclaw calls gmail.send
(repeat daily, no memory of what was triaged)
```

Con Lobster:

```json
{
  "action": "run",
  "pipeline": "email.triage --limit 20",
  "timeoutMs": 30000
}
```

Devuelve un sobre JSON (truncado):

```json
{
  "ok": true,
  "status": "needs_approval",
  "output": [{ "summary": "5 need replies, 2 need action" }],
  "requiresApproval": {
    "type": "approval_request",
    "prompt": "Send 2 draft replies?",
    "items": [],
    "resumeToken": "..."
  }
}
```

El usuario aprueba → reanudar:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Un flujo de trabajo. Determinista. Seguro.

## Parámetros de la herramienta

### `run`

Ejecuta un pipeline en modo herramienta.

```json
{
  "action": "run",
  "pipeline": "gog.gmail.search --query 'newer_than:1d' | email.triage",
  "cwd": "/path/to/workspace",
  "timeoutMs": 30000,
  "maxStdoutBytes": 512000
}
```

Ejecuta un archivo de flujo de trabajo con argumentos:

```json
{
  "action": "run",
  "pipeline": "/path/to/inbox-triage.lobster",
  "argsJson": "{\"tag\":\"family\"}"
}
```

### `resume`

Continúa un flujo de trabajo detenido después de la aprobación.

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

### Entradas opcionales

- `lobsterPath`: Ruta absoluta al binario de Lobster (omitir para usar `PATH`).
- `cwd`: Directorio de trabajo para el pipeline (por defecto, el directorio de trabajo del proceso actual).
- `timeoutMs`: Finaliza el subproceso si excede esta duración (predeterminado: 20000).
- `maxStdoutBytes`: Finaliza el subproceso si stdout excede este tamaño (predeterminado: 512000).
- `argsJson`: Cadena JSON pasada a `lobster run --args-json` (solo archivos de flujo de trabajo).

## Sobre de salida

Lobster devuelve un sobre JSON con uno de tres estados:

- `ok` → finalizó correctamente
- `needs_approval` → en pausa; se requiere `requiresApproval.resumeToken` para reanudar
- `cancelled` → denegado explícitamente o cancelado

La herramienta expone el sobre tanto en `content` (JSON con formato) como en `details` (objeto sin procesar).

## Aprobaciones

Si `requiresApproval` está presente, inspeccione el prompt y decida:

- `approve: true` → reanudar y continuar los efectos secundarios
- `approve: false` → cancelar y finalizar el flujo de trabajo

Use `approve --preview-from-stdin --limit N` para adjuntar una vista previa JSON a las solicitudes de aprobación sin pegamento personalizado de jq/heredoc. Los tokens de reanudación ahora son compactos: Lobster almacena el estado de reanudación del flujo de trabajo bajo su directorio de estado y devuelve una pequeña clave de token.

## OpenProse

OpenProse combina bien con Lobster: use `/prose` para orquestar la preparación de múltiples agentes y luego ejecute un pipeline de Lobster para aprobaciones deterministas. Si un programa de Prose necesita Lobster, permita la herramienta `lobster` para subagentes mediante `tools.subagents.tools`. Vea [OpenProse](/prose).

## Seguridad

- **Solo subprocesos locales** — sin llamadas de red desde el propio plugin.
- **Sin secretos** — Lobster no gestiona OAuth; llama a herramientas de OpenClaw que sí lo hacen.
- **Consciente del sandbox** — deshabilitado cuando el contexto de la herramienta está en sandbox.
- **Endurecido** — `lobsterPath` debe ser absoluto si se especifica; se aplican tiempos de espera y límites de salida.

## Solución de problemas

- **`lobster subprocess timed out`** → aumente `timeoutMs` o divida un pipeline largo.
- **`lobster output exceeded maxStdoutBytes`** → eleve `maxStdoutBytes` o reduzca el tamaño de la salida.
- **`lobster returned invalid JSON`** → asegúrese de que el pipeline se ejecute en modo herramienta y emita solo JSON.
- **`lobster failed (code …)`** → ejecute el mismo pipeline en una terminal para inspeccionar stderr.

## Aprenda más

- [Plugins](/tools/plugin)
- [Autoría de herramientas de plugin](/plugins/agent-tools)

## Estudio de caso: flujos de trabajo de la comunidad

Un ejemplo público: una CLI de “segundo cerebro” + pipelines de Lobster que gestionan tres bóvedas Markdown (personal, de pareja, compartida). La CLI emite JSON para estadísticas, listados de bandeja de entrada y escaneos de obsolescencia; Lobster encadena esos comandos en flujos de trabajo como `weekly-review`, `inbox-triage`, `memory-consolidation` y `shared-task-sync`, cada uno con compuertas de aprobación. La IA maneja el juicio (categorización) cuando está disponible y recurre a reglas deterministas cuando no lo está.

- Hilo: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repo: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
