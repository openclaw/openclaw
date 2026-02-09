---
summary: "Backends de CLI: alternativa solo de texto mediante CLIs de IA locales"
read_when:
  - Quiere una alternativa confiable cuando los proveedores de API fallan
  - Está ejecutando Claude Code CLI u otras CLIs de IA locales y quiere reutilizarlas
  - Necesita una ruta solo de texto, sin herramientas, que aun así admita sesiones e imágenes
title: "Backends de CLI"
---

# Backends de CLI (entorno de ejecución de respaldo)

OpenClaw puede ejecutar **CLIs de IA locales** como una **alternativa solo de texto** cuando los proveedores de API están caídos,
limitados por tasa o se comportan mal temporalmente. Esto es intencionalmente conservador:

- **Las herramientas están deshabilitadas** (sin llamadas a herramientas).
- **Texto entra → texto sale** (confiable).
- **Se admiten sesiones** (para que los turnos de seguimiento se mantengan coherentes).
- **Las imágenes pueden pasarse** si la CLI acepta rutas de imágenes.

Esto está diseñado como una **red de seguridad** más que como una ruta principal. Úselo cuando
quiera respuestas de texto que “siempre funcionan” sin depender de APIs externas.

## Inicio rápido para principiantes

Puede usar Claude Code CLI **sin ninguna configuración** (OpenClaw incluye un valor predeterminado integrado):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI también funciona listo para usar:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Si su Gateway se ejecuta bajo launchd/systemd y PATH es mínimo, agregue solo la
ruta del comando:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
      },
    },
  },
}
```

Eso es todo. No se necesitan claves ni configuración adicional de autenticación más allá de la propia CLI.

## Uso como respaldo

Agregue un backend de CLI a su lista de fallback para que solo se ejecute cuando fallen los modelos primarios:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-cli/opus-4.6", "claude-cli/opus-4.5"],
      },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "claude-cli/opus-4.6": {},
        "claude-cli/opus-4.5": {},
      },
    },
  },
}
```

Notas:

- Si usa `agents.defaults.models` (lista de permitidos), debe incluir `claude-cli/...`.
- Si el proveedor principal falla (autenticación, límites de tasa, tiempos de espera), OpenClaw
  intentará el backend de CLI a continuación.

## Descripción general de la configuración

Todos los backends de CLI viven en:

```
agents.defaults.cliBackends
```

Cada entrada se identifica por un **id de proveedor** (p. ej., `claude-cli`, `my-cli`).
El id del proveedor se convierte en el lado izquierdo de su referencia de modelo:

```
<provider>/<model>
```

### Configuración de ejemplo

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          input: "arg",
          modelArg: "--model",
          modelAliases: {
            "claude-opus-4-6": "opus",
            "claude-opus-4-5": "opus",
            "claude-sonnet-4-5": "sonnet",
          },
          sessionArg: "--session",
          sessionMode: "existing",
          sessionIdFields: ["session_id", "conversation_id"],
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
          serialize: true,
        },
      },
    },
  },
}
```

## Cómo funciona

1. **Selecciona un backend** según el prefijo del proveedor (`claude-cli/...`).
2. **Construye un prompt del sistema** usando el mismo prompt de OpenClaw + el contexto del espacio de trabajo.
3. **Ejecuta la CLI** con un id de sesión (si se admite) para que el historial se mantenga consistente.
4. **Analiza la salida** (JSON o texto plano) y devuelve el texto final.
5. **Persiste los ids de sesión** por backend, para que los seguimientos reutilicen la misma sesión de la CLI.

## Sesiones

- Si la CLI admite sesiones, establezca `sessionArg` (p. ej., `--session-id`) o
  `sessionArgs` (marcador de posición `{sessionId}`) cuando el ID deba insertarse
  en múltiples flags.
- Si la CLI usa un **subcomando de reanudación** con flags diferentes, establezca
  `resumeArgs` (reemplaza `args` al reanudar) y, de forma opcional, `resumeOutput`
  (para reanudaciones no JSON).
- `sessionMode`:
  - `always`: siempre envía un id de sesión (nuevo UUID si no hay uno almacenado).
  - `existing`: solo envía un id de sesión si se almacenó uno previamente.
  - `none`: nunca envía un id de sesión.

## Imágenes (paso directo)

Si su CLI acepta rutas de imágenes, establezca `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw escribirá las imágenes base64 en archivos temporales. Si se establece `imageArg`, esas
rutas se pasan como argumentos de la CLI. Si falta `imageArg`, OpenClaw agrega las
rutas de archivo al prompt (inyección de rutas), lo cual es suficiente para CLIs que cargan
automáticamente archivos locales desde rutas simples (comportamiento de Claude Code CLI).

## Entradas / salidas

- `output: "json"` (predeterminado) intenta analizar JSON y extraer texto + id de sesión.
- `output: "jsonl"` analiza streams JSONL (Codex CLI `--json`) y extrae el
  último mensaje del agente más `thread_id` cuando está presente.
- `output: "text"` trata stdout como la respuesta final.

Modos de entrada:

- `input: "arg"` (predeterminado) pasa el prompt como el último argumento de la CLI.
- `input: "stdin"` envía el prompt vía stdin.
- Si el prompt es muy largo y se establece `maxPromptArgChars`, se usa stdin.

## Valores predeterminados (integrados)

OpenClaw incluye un valor predeterminado para `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw también incluye un valor predeterminado para `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Anule solo si es necesario (común: ruta absoluta de `command`).

## Limitaciones

- **Sin herramientas de OpenClaw** (el backend de CLI nunca recibe llamadas de herramientas). Algunas CLIs
  aún pueden ejecutar su propio tooling de agente.
- **Sin streaming** (la salida de la CLI se recopila y luego se devuelve).
- **Salidas estructuradas** dependen del formato JSON de la CLI.
- **Sesiones de Codex CLI** se reanudan mediante salida de texto (sin JSONL), lo que es menos
  estructurado que la ejecución inicial `--json`. Las sesiones de OpenClaw
  siguen funcionando con normalidad.

## Solución de problemas

- **CLI no encontrada**: establezca `command` en una ruta completa.
- **Nombre de modelo incorrecto**: use `modelAliases` para mapear `provider/model` → modelo de la CLI.
- **Sin continuidad de sesión**: asegúrese de que `sessionArg` esté establecido y que `sessionMode` no sea
  `none` (Codex CLI actualmente no puede reanudar con salida JSON).
- **Imágenes ignoradas**: establezca `imageArg` (y verifique que la CLI admita rutas de archivos).
