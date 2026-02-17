---
title: Lobster
summary: "Runtime de flujos de trabajo tipados para OpenClaw con puertas de aprobación reanudables."
description: Runtime de flujos de trabajo tipados para OpenClaw — pipelines composables con puertas de aprobación.
read_when:
  - Quieres flujos de trabajo multi-paso determinísticos con aprobaciones explícitas
  - Necesitas reanudar un flujo de trabajo sin reejecutar pasos anteriores
---

# Lobster

Lobster es un shell de flujos de trabajo que permite a OpenClaw ejecutar secuencias de herramientas multi-paso como una única operación determinística con puntos de aprobación explícitos.

## Gancho

Tu asistente puede construir las herramientas que lo gestionan a sí mismo. Pide un flujo de trabajo, y 30 minutos después tienes una CLI más pipelines que se ejecutan como una sola llamada. Lobster es la pieza faltante: pipelines determinísticos, aprobaciones explícitas y estado reanudable.

## Por Qué

Hoy, los flujos de trabajo complejos requieren muchas llamadas de herramientas de ida y vuelta. Cada llamada cuesta tokens, y el LLM tiene que orquestar cada paso. Lobster mueve esa orquestación a un runtime tipado:

- **Una llamada en lugar de muchas**: OpenClaw ejecuta una llamada de herramienta Lobster y obtiene un resultado estructurado.
- **Aprobaciones integradas**: Los efectos secundarios (enviar email, publicar comentario) detienen el flujo de trabajo hasta que se aprueban explícitamente.
- **Reanudable**: Los flujos de trabajo detenidos devuelven un token; aprueba y reanuda sin reejecutar todo.

## ¿Por Qué un DSL en Lugar de Programas Simples?

Lobster es intencionalmente pequeño. El objetivo no es "un nuevo lenguaje", es una especificación de pipeline predecible y amigable con IA con aprobaciones de primera clase y tokens de reanudación.

- **Aprobar/reanudar está integrado**: Un programa normal puede preguntar a un humano, pero no puede _pausar y reanudar_ con un token duradero sin que inventes ese runtime tú mismo.
- **Determinismo + auditabilidad**: Los pipelines son datos, por lo que son fáciles de registrar, comparar, reproducir y revisar.
- **Superficie limitada para IA**: Una gramática diminuta + piping JSON reduce rutas de código "creativas" y hace que la validación sea realista.
- **Política de seguridad incorporada**: Tiempos de espera, límites de salida, verificaciones de sandbox y listas blancas son aplicados por el runtime, no por cada script.
- **Aún programable**: Cada paso puede llamar a cualquier CLI o script. Si quieres JS/TS, genera archivos `.lobster` desde código.

## Cómo Funciona

OpenClaw lanza la CLI local `lobster` en **modo herramienta** y analiza un sobre JSON desde stdout.
Si el pipeline se pausa para aprobación, la herramienta devuelve un `resumeToken` para que puedas continuar después.

## Patrón: CLI Pequeña + Pipes JSON + Aprobaciones

Construye comandos diminutos que hablan JSON, luego encadénalos en una sola llamada Lobster. (Los nombres de comandos de ejemplo a continuación — intercambia por los tuyos propios.)

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

Si el pipeline solicita aprobación, reanuda con el token:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

La IA desencadena el flujo de trabajo; Lobster ejecuta los pasos. Las puertas de aprobación mantienen los efectos secundarios explícitos y auditables.

Ejemplo: mapea elementos de entrada en llamadas de herramientas:

```bash
gog.gmail.search --query 'newer_than:1d' \
  | openclaw.invoke --tool message --action send --each --item-key message --args-json '{"provider":"telegram","to":"..."}'
```

## Pasos LLM Solo-JSON (llm-task)

Para flujos de trabajo que necesitan un **paso LLM estructurado**, habilita la herramienta de plugin opcional `llm-task` y llámala desde Lobster. Esto mantiene el flujo de trabajo determinístico mientras aún te permite clasificar/resumir/redactar con un modelo.

Habilita la herramienta:

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

Úsala en un pipeline:

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

Ver [Tarea LLM](/es-ES/tools/llm-task) para detalles y opciones de configuración.

## Archivos de Flujo de Trabajo (.lobster)

Lobster puede ejecutar archivos de flujo de trabajo YAML/JSON con campos `name`, `args`, `steps`, `env`, `condition` y `approval`. En llamadas de herramienta OpenClaw, establece `pipeline` a la ruta del archivo.

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

- `stdin: $step.stdout` y `stdin: $step.json` pasan la salida de un paso anterior.
- `condition` (o `when`) puede cerrar pasos en `$step.approved`.

## Instalar Lobster

Instala la CLI de Lobster en el **mismo host** que ejecuta el Gateway de OpenClaw (ver el [repositorio de Lobster](https://github.com/openclaw/lobster)), y asegúrate de que `lobster` esté en `PATH`.
Si quieres usar una ubicación de binario personalizada, pasa un `lobsterPath` **absoluto** en la llamada de herramienta.

## Habilitar la Herramienta

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

Evita usar `tools.allow: ["lobster"]` a menos que pretendas ejecutar en modo de lista blanca restrictivo.

Nota: las listas blancas son opt-in para plugins opcionales. Si tu lista blanca solo nombra herramientas de plugin (como `lobster`), OpenClaw mantiene las herramientas centrales habilitadas. Para restringir herramientas centrales, incluye las herramientas o grupos centrales que desees en la lista blanca también.

## Ejemplo: Triage de Email

Sin Lobster:

```
Usuario: "Revisa mi email y redacta respuestas"
→ openclaw llama gmail.list
→ LLM resume
→ Usuario: "redacta respuestas a #2 y #5"
→ LLM redacta
→ Usuario: "envía #2"
→ openclaw llama gmail.send
(repetir diariamente, sin memoria de lo que fue triado)
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

Usuario aprueba → reanudar:

```json
{
  "action": "resume",
  "token": "<resumeToken>",
  "approve": true
}
```

Un flujo de trabajo. Determinístico. Seguro.

## Parámetros de la Herramienta

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

### Entradas Opcionales

- `lobsterPath`: Ruta absoluta al binario de Lobster (omitir para usar `PATH`).
- `cwd`: Directorio de trabajo para el pipeline (por defecto al directorio de trabajo del proceso actual).
- `timeoutMs`: Mata el subproceso si excede esta duración (por defecto: 20000).
- `maxStdoutBytes`: Mata el subproceso si stdout excede este tamaño (por defecto: 512000).
- `argsJson`: Cadena JSON pasada a `lobster run --args-json` (solo archivos de flujo de trabajo).

## Sobre de Salida

Lobster devuelve un sobre JSON con uno de tres estados:

- `ok` → finalizado exitosamente
- `needs_approval` → pausado; se requiere `requiresApproval.resumeToken` para reanudar
- `cancelled` → explícitamente denegado o cancelado

La herramienta presenta el sobre tanto en `content` (JSON bonito) como en `details` (objeto crudo).

## Aprobaciones

Si `requiresApproval` está presente, inspecciona el prompt y decide:

- `approve: true` → reanudar y continuar efectos secundarios
- `approve: false` → cancelar y finalizar el flujo de trabajo

Usa `approve --preview-from-stdin --limit N` para adjuntar una vista previa JSON a solicitudes de aprobación sin pegamento jq/heredoc personalizado. Los tokens de reanudación ahora son compactos: Lobster almacena el estado de reanudación del flujo de trabajo bajo su directorio de estado y devuelve una pequeña clave token.

## OpenProse

OpenProse se empareja bien con Lobster: usa `/prose` para orquestar preparación multi-agente, luego ejecuta un pipeline Lobster para aprobaciones determinísticas. Si un programa Prose necesita Lobster, permite la herramienta `lobster` para sub-agentes vía `tools.subagents.tools`. Ver [OpenProse](/prose).

## Seguridad

- **Solo subproceso local** — sin llamadas de red desde el plugin en sí.
- **Sin secretos** — Lobster no gestiona OAuth; llama a herramientas de OpenClaw que lo hacen.
- **Consciente de sandbox** — deshabilitado cuando el contexto de la herramienta está en sandbox.
- **Endurecido** — `lobsterPath` debe ser absoluto si se especifica; tiempos de espera y límites de salida aplicados.

## Solución de Problemas

- **`lobster subprocess timed out`** → aumenta `timeoutMs`, o divide un pipeline largo.
- **`lobster output exceeded maxStdoutBytes`** → aumenta `maxStdoutBytes` o reduce el tamaño de salida.
- **`lobster returned invalid JSON`** → asegúrate de que el pipeline se ejecute en modo herramienta e imprima solo JSON.
- **`lobster failed (code …)`** → ejecuta el mismo pipeline en una terminal para inspeccionar stderr.

## Aprende Más

- [Plugins](/es-ES/tools/plugin)
- [Autoría de herramientas de plugin](/plugins/agent-tools)

## Caso de Estudio: Flujos de Trabajo Comunitarios

Un ejemplo público: una CLI de "segundo cerebro" + pipelines Lobster que gestionan tres bóvedas Markdown (personal, pareja, compartida). La CLI emite JSON para estadísticas, listados de bandeja de entrada y escaneos obsoletos; Lobster encadena esos comandos en flujos de trabajo como `weekly-review`, `inbox-triage`, `memory-consolidation` y `shared-task-sync`, cada uno con puertas de aprobación. La IA maneja juicio (categorización) cuando está disponible y recurre a reglas determinísticas cuando no lo está.

- Hilo: [https://x.com/plattenschieber/status/2014508656335770033](https://x.com/plattenschieber/status/2014508656335770033)
- Repositorio: [https://github.com/bloomedai/brain-cli](https://github.com/bloomedai/brain-cli)
