---
summary: "Backends CLI: fallback solo texto vía CLIs de IA locales"
read_when:
  - Quieres un fallback confiable cuando fallen los proveedores de API
  - Estás ejecutando Claude Code CLI u otros CLIs de IA locales y quieres reutilizarlos
  - Necesitas una ruta solo texto, sin herramientas que aún soporte sesiones e imágenes
title: "Backends CLI"
---

# Backends CLI (runtime fallback)

OpenClaw puede ejecutar **CLIs de IA locales** como un **fallback solo texto** cuando los proveedores de API están caídos,
con límites de tasa, o con mal comportamiento temporal. Esto es intencionalmente conservador:

- **Las herramientas están deshabilitadas** (sin llamadas a herramientas).
- **Texto in → texto out** (confiable).
- **Las sesiones están soportadas** (para que los turnos de seguimiento permanezcan coherentes).
- **Las imágenes pueden pasarse** si el CLI acepta rutas de imagen.

Esto está diseñado como una **red de seguridad** más que una ruta primaria. Úsalo cuando
quieras respuestas de texto "siempre funciona" sin depender de APIs externas.

## Inicio rápido amigable para principiantes

Puedes usar Claude Code CLI **sin ninguna configuración** (OpenClaw incluye un predeterminado integrado):

```bash
openclaw agent --message "hi" --model claude-cli/opus-4.6
```

Codex CLI también funciona sin configuración:

```bash
openclaw agent --message "hi" --model codex-cli/gpt-5.3-codex
```

Si tu gateway se ejecuta bajo launchd/systemd y PATH es mínimo, agrega solo la
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

Eso es todo. No se necesitan claves, ni configuración de auth extra más allá del CLI mismo.

## Usándolo como fallback

Agrega un backend CLI a tu lista de fallback para que solo se ejecute cuando fallen los modelos primarios:

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

- Si usas `agents.defaults.models` (lista permitida), debes incluir `claude-cli/...`.
- Si el proveedor primario falla (auth, límites de tasa, timeouts), OpenClaw
  intentará el backend CLI a continuación.

## Visión general de configuración

Todos los backends CLI viven bajo:

```
agents.defaults.cliBackends
```

Cada entrada está indexada por un **ID de proveedor** (por ejemplo, `claude-cli`, `my-cli`).
El ID de proveedor se convierte en el lado izquierdo de tu referencia de modelo:

```
<proveedor>/<modelo>
```

### Ejemplo de configuración

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

1. **Selecciona un backend** basado en el prefijo del proveedor (`claude-cli/...`).
2. **Construye un prompt del sistema** usando el mismo prompt de OpenClaw + contexto del workspace.
3. **Ejecuta el CLI** con un ID de sesión (si está soportado) para que el historial permanezca consistente.
4. **Analiza la salida** (JSON o texto plano) y devuelve el texto final.
5. **Persiste IDs de sesión** por backend, para que los seguimientos reutilicen la misma sesión CLI.

## Sesiones

- Si el CLI soporta sesiones, establece `sessionArg` (por ejemplo, `--session-id`) o
  `sessionArgs` (placeholder `{sessionId}`) cuando el ID necesita insertarse
  en múltiples flags.
- Si el CLI usa un **subcomando resume** con flags diferentes, establece
  `resumeArgs` (reemplaza `args` cuando se reanuda) y opcionalmente `resumeOutput`
  (para resumes no JSON).
- `sessionMode`:
  - `always`: siempre envía un ID de sesión (nuevo UUID si no hay ninguno almacenado).
  - `existing`: solo envía un ID de sesión si uno fue almacenado antes.
  - `none`: nunca envía un ID de sesión.

## Imágenes (pass-through)

Si tu CLI acepta rutas de imagen, establece `imageArg`:

```json5
imageArg: "--image",
imageMode: "repeat"
```

OpenClaw escribirá imágenes base64 en archivos temporales. Si `imageArg` está establecido, esas
rutas se pasan como args CLI. Si `imageArg` falta, OpenClaw añade las
rutas de archivo al prompt (inyección de ruta), lo cual es suficiente para CLIs que auto-
cargan archivos locales desde rutas planas (comportamiento de Claude Code CLI).

## Entradas / salidas

- `output: "json"` (predeterminado) intenta analizar JSON y extraer texto + ID de sesión.
- `output: "jsonl"` analiza streams JSONL (Codex CLI `--json`) y extrae el
  último mensaje del agente más `thread_id` cuando está presente.
- `output: "text"` trata stdout como la respuesta final.

Modos de entrada:

- `input: "arg"` (predeterminado) pasa el prompt como el último arg CLI.
- `input: "stdin"` envía el prompt vía stdin.
- Si el prompt es muy largo y `maxPromptArgChars` está establecido, se usa stdin.

## Predeterminados (integrados)

OpenClaw incluye un predeterminado para `claude-cli`:

- `command: "claude"`
- `args: ["-p", "--output-format", "json", "--dangerously-skip-permissions"]`
- `resumeArgs: ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--resume", "{sessionId}"]`
- `modelArg: "--model"`
- `systemPromptArg: "--append-system-prompt"`
- `sessionArg: "--session-id"`
- `systemPromptWhen: "first"`
- `sessionMode: "always"`

OpenClaw también incluye un predeterminado para `codex-cli`:

- `command: "codex"`
- `args: ["exec","--json","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `resumeArgs: ["exec","resume","{sessionId}","--color","never","--sandbox","read-only","--skip-git-repo-check"]`
- `output: "jsonl"`
- `resumeOutput: "text"`
- `modelArg: "--model"`
- `imageArg: "--image"`
- `sessionMode: "existing"`

Sobreescribe solo si es necesario (común: ruta `command` absoluta).

## Limitaciones

- **Sin herramientas de OpenClaw** (el backend CLI nunca recibe llamadas a herramientas). Algunos CLIs
  aún pueden ejecutar su propio tooling de agente.
- **Sin streaming** (la salida CLI se recopila y luego se devuelve).
- **Salidas estructuradas** dependen del formato JSON del CLI.
- **Sesiones de Codex CLI** se reanudan vía salida de texto (sin JSONL), lo cual es menos
  estructurado que la ejecución inicial `--json`. Las sesiones de OpenClaw aún funcionan
  normalmente.

## Solución de Problemas

- **CLI no encontrado**: establece `command` a una ruta completa.
- **Nombre de modelo incorrecto**: usa `modelAliases` para mapear `proveedor/modelo` → modelo CLI.
- **Sin continuidad de sesión**: asegúrate de que `sessionArg` esté establecido y `sessionMode` no sea
  `none` (Codex CLI actualmente no puede reanudar con salida JSON).
- **Imágenes ignoradas**: establece `imageArg` (y verifica que el CLI soporte rutas de archivo).
