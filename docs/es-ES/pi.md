---
title: "Arquitectura de Integración de Pi"
---

# Arquitectura de Integración de Pi

Este documento describe cómo OpenClaw se integra con [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) y sus paquetes hermanos (`pi-ai`, `pi-agent-core`, `pi-tui`) para potenciar sus capacidades de agente IA.

## Descripción General

OpenClaw utiliza el SDK de Pi para incrustar un agente de codificación IA en su arquitectura de Gateway de mensajería. En lugar de generar Pi como un subproceso o usar el modo RPC, OpenClaw importa directamente e instancia `AgentSession` de Pi mediante `createAgentSession()`. Este enfoque incrustado proporciona:

- Control completo sobre el ciclo de vida de la sesión y el manejo de eventos
- Inyección de herramientas personalizadas (mensajería, sandbox, acciones específicas del canal)
- Personalización del prompt del sistema por canal/contexto
- Persistencia de sesiones con soporte de ramificación/compactación
- Rotación de perfiles de autenticación multi-cuenta con failover
- Cambio de modelos agnóstico del proveedor

## Dependencias de Paquetes

```json
{
  "@mariozechner/pi-agent-core": "0.49.3",
  "@mariozechner/pi-ai": "0.49.3",
  "@mariozechner/pi-coding-agent": "0.49.3",
  "@mariozechner/pi-tui": "0.49.3"
}
```

| Paquete           | Propósito                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pi-ai`           | Abstracciones principales de LLM: `Model`, `streamSimple`, tipos de mensajes, APIs de proveedores                  |
| `pi-agent-core`   | Bucle de agente, ejecución de herramientas, tipos `AgentMessage`                                                   |
| `pi-coding-agent` | SDK de alto nivel: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, herramientas integradas |
| `pi-tui`          | Componentes de interfaz de terminal (usados en el modo TUI local de OpenClaw)                                      |

## Estructura de Archivos

```
src/agents/
├── pi-embedded-runner.ts          # Re-exportaciones desde pi-embedded-runner/
├── pi-embedded-runner/
│   ├── run.ts                     # Entrada principal: runEmbeddedPiAgent()
│   ├── run/
│   │   ├── attempt.ts             # Lógica de un solo intento con configuración de sesión
│   │   ├── params.ts              # Tipo RunEmbeddedPiAgentParams
│   │   ├── payloads.ts            # Construcción de cargas útiles de respuesta desde resultados de ejecución
│   │   ├── images.ts              # Inyección de imágenes del modelo de visión
│   │   └── types.ts               # EmbeddedRunAttemptResult
│   ├── abort.ts                   # Detección de errores de aborto
│   ├── cache-ttl.ts               # Seguimiento de TTL de caché para poda de contexto
│   ├── compact.ts                 # Lógica de compactación manual/automática
│   ├── extensions.ts              # Carga de extensiones de Pi para ejecuciones incrustadas
│   ├── extra-params.ts            # Parámetros de streaming específicos del proveedor
│   ├── google.ts                  # Correcciones de orden de turnos de Google/Gemini
│   ├── history.ts                 # Limitación de historial (mensaje directo vs grupo)
│   ├── lanes.ts                   # Carriles de comandos de sesión/globales
│   ├── logger.ts                  # Logger de subsistema
│   ├── model.ts                   # Resolución de modelos vía ModelRegistry
│   ├── runs.ts                    # Seguimiento de ejecución activa, aborto, cola
│   ├── sandbox-info.ts            # Información de sandbox para prompt del sistema
│   ├── session-manager-cache.ts   # Caché de instancias de SessionManager
│   ├── session-manager-init.ts    # Inicialización de archivos de sesión
│   ├── system-prompt.ts           # Constructor de prompt del sistema
│   ├── tool-split.ts              # División de herramientas en builtIn vs personalizadas
│   ├── types.ts                   # EmbeddedPiAgentMeta, EmbeddedPiRunResult
│   └── utils.ts                   # Mapeo de ThinkLevel, descripción de errores
├── pi-embedded-subscribe.ts       # Suscripción/despacho de eventos de sesión
├── pi-embedded-subscribe.types.ts # SubscribeEmbeddedPiSessionParams
├── pi-embedded-subscribe.handlers.ts # Fábrica de manejadores de eventos
├── pi-embedded-subscribe.handlers.lifecycle.ts
├── pi-embedded-subscribe.handlers.types.ts
├── pi-embedded-block-chunker.ts   # Fragmentación de respuestas de bloques de streaming
├── pi-embedded-messaging.ts       # Seguimiento de envío de herramientas de mensajería
├── pi-embedded-helpers.ts         # Clasificación de errores, validación de turnos
├── pi-embedded-helpers/           # Módulos auxiliares
├── pi-embedded-utils.ts           # Utilidades de formato
├── pi-tools.ts                    # createOpenClawCodingTools()
├── pi-tools.abort.ts              # Envoltura de AbortSignal para herramientas
├── pi-tools.policy.ts             # Política de lista permitida/denegada de herramientas
├── pi-tools.read.ts               # Personalizaciones de herramienta de lectura
├── pi-tools.schema.ts             # Normalización de esquemas de herramientas
├── pi-tools.types.ts              # Alias de tipo AnyAgentTool
├── pi-tool-definition-adapter.ts  # Adaptador AgentTool -> ToolDefinition
├── pi-settings.ts                 # Anulaciones de configuración
├── pi-extensions/                 # Extensiones personalizadas de Pi
│   ├── compaction-safeguard.ts    # Extensión de salvaguarda
│   ├── compaction-safeguard-runtime.ts
│   ├── context-pruning.ts         # Extensión de poda de contexto Cache-TTL
│   └── context-pruning/
├── model-auth.ts                  # Resolución de perfiles de autenticación
├── auth-profiles.ts               # Almacén de perfiles, enfriamiento, failover
├── model-selection.ts             # Resolución de modelos predeterminados
├── models-config.ts               # Generación de models.json
├── model-catalog.ts               # Caché de catálogo de modelos
├── context-window-guard.ts        # Validación de ventana de contexto
├── failover-error.ts              # Clase FailoverError
├── defaults.ts                    # DEFAULT_PROVIDER, DEFAULT_MODEL
├── system-prompt.ts               # buildAgentSystemPrompt()
├── system-prompt-params.ts        # Resolución de parámetros de prompt del sistema
├── system-prompt-report.ts        # Generación de informes de depuración
├── tool-summaries.ts              # Resúmenes de descripciones de herramientas
├── tool-policy.ts                 # Resolución de políticas de herramientas
├── transcript-policy.ts           # Política de validación de transcripciones
├── skills.ts                      # Construcción de instantáneas/prompts de habilidades
├── skills/                        # Subsistema de habilidades
├── sandbox.ts                     # Resolución de contexto de sandbox
├── sandbox/                       # Subsistema de sandbox
├── channel-tools.ts               # Inyección de herramientas específicas del canal
├── openclaw-tools.ts              # Herramientas específicas de OpenClaw
├── bash-tools.ts                  # Herramientas exec/process
├── apply-patch.ts                 # Herramienta apply_patch (OpenAI)
├── tools/                         # Implementaciones individuales de herramientas
│   ├── browser-tool.ts
│   ├── canvas-tool.ts
│   ├── cron-tool.ts
│   ├── discord-actions*.ts
│   ├── gateway-tool.ts
│   ├── image-tool.ts
│   ├── message-tool.ts
│   ├── nodes-tool.ts
│   ├── session*.ts
│   ├── slack-actions.ts
│   ├── telegram-actions.ts
│   ├── web-*.ts
│   └── whatsapp-actions.ts
└── ...
```

## Flujo de Integración Principal

### 1. Ejecución de un Agente Incrustado

El punto de entrada principal es `runEmbeddedPiAgent()` en `pi-embedded-runner/run.ts`:

```typescript
import { runEmbeddedPiAgent } from "./agents/pi-embedded-runner.js";

const result = await runEmbeddedPiAgent({
  sessionId: "user-123",
  sessionKey: "main:whatsapp:+1234567890",
  sessionFile: "/path/to/session.jsonl",
  workspaceDir: "/path/to/workspace",
  config: openclawConfig,
  prompt: "Hola, ¿cómo estás?",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  timeoutMs: 120_000,
  runId: "run-abc",
  onBlockReply: async (payload) => {
    await sendToChannel(payload.text, payload.mediaUrls);
  },
});
```

### 2. Creación de Sesión

Dentro de `runEmbeddedAttempt()` (llamado por `runEmbeddedPiAgent()`), se utiliza el SDK de Pi:

```typescript
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedWorkspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths,
});
await resourceLoader.reload();

const { session } = await createAgentSession({
  cwd: resolvedWorkspace,
  agentDir,
  authStorage: params.authStorage,
  modelRegistry: params.modelRegistry,
  model: params.model,
  thinkingLevel: mapThinkingLevel(params.thinkLevel),
  tools: builtInTools,
  customTools: allCustomTools,
  sessionManager,
  settingsManager,
  resourceLoader,
});

applySystemPromptOverrideToSession(session, systemPromptOverride);
```

### 3. Suscripción de Eventos

`subscribeEmbeddedPiSession()` se suscribe a los eventos de `AgentSession` de Pi:

```typescript
const subscription = subscribeEmbeddedPiSession({
  session: activeSession,
  runId: params.runId,
  verboseLevel: params.verboseLevel,
  reasoningMode: params.reasoningLevel,
  toolResultFormat: params.toolResultFormat,
  onToolResult: params.onToolResult,
  onReasoningStream: params.onReasoningStream,
  onBlockReply: params.onBlockReply,
  onPartialReply: params.onPartialReply,
  onAgentEvent: params.onAgentEvent,
});
```

Los eventos manejados incluyen:

- `message_start` / `message_end` / `message_update` (streaming de texto/pensamiento)
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`
- `turn_start` / `turn_end`
- `agent_start` / `agent_end`
- `auto_compaction_start` / `auto_compaction_end`

### 4. Prompting

Después de la configuración, se solicita la sesión:

```typescript
await session.prompt(effectivePrompt, { images: imageResult.images });
```

El SDK maneja el bucle completo del agente: envío al LLM, ejecución de llamadas de herramientas, streaming de respuestas.

## Arquitectura de Herramientas

### Pipeline de Herramientas

1. **Herramientas Base**: `codingTools` de Pi (read, bash, edit, write)
2. **Reemplazos Personalizados**: OpenClaw reemplaza bash con `exec`/`process`, personaliza read/edit/write para sandbox
3. **Herramientas de OpenClaw**: mensajería, navegador, lienzo, sesiones, cron, Gateway, etc.
4. **Herramientas de Canal**: Herramientas de acción específicas de Discord/Telegram/Slack/WhatsApp
5. **Filtrado de Políticas**: Herramientas filtradas por perfil, proveedor, agente, grupo, políticas de sandbox
6. **Normalización de Esquemas**: Esquemas limpiados para peculiaridades de Gemini/OpenAI
7. **Envoltura de AbortSignal**: Herramientas envueltas para respetar señales de aborto

### Adaptador de Definición de Herramientas

`AgentTool` de pi-agent-core tiene una firma `execute` diferente a `ToolDefinition` de pi-coding-agent. El adaptador en `pi-tool-definition-adapter.ts` conecta esto:

```typescript
export function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (toolCallId, params, onUpdate, _ctx, signal) => {
      // la firma de pi-coding-agent difiere de pi-agent-core
      return await tool.execute(toolCallId, params, signal, onUpdate);
    },
  }));
}
```

### Estrategia de División de Herramientas

`splitSdkTools()` pasa todas las herramientas mediante `customTools`:

```typescript
export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }) {
  return {
    builtInTools: [], // Vacío. Anulamos todo
    customTools: toToolDefinitions(options.tools),
  };
}
```

Esto garantiza que el filtrado de políticas de OpenClaw, la integración de sandbox y el conjunto de herramientas extendido permanezcan consistentes entre proveedores.

## Construcción del Prompt del Sistema

El prompt del sistema se construye en `buildAgentSystemPrompt()` (`system-prompt.ts`). Ensambla un prompt completo con secciones que incluyen Herramientas, Estilo de Llamada de Herramientas, salvaguardas de Seguridad, referencia de CLI de OpenClaw, Habilidades, Documentos, Espacio de trabajo, Sandbox, Mensajería, Etiquetas de Respuesta, Voz, Respuestas Silenciosas, Latidos, metadatos de Runtime, además de Memoria y Reacciones cuando están habilitados, y contenido opcional de archivos de contexto y prompt del sistema adicional. Las secciones se recortan para el modo de prompt mínimo utilizado por subagentes.

El prompt se aplica después de la creación de la sesión mediante `applySystemPromptOverrideToSession()`:

```typescript
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
applySystemPromptOverrideToSession(session, systemPromptOverride);
```

## Gestión de Sesiones

### Archivos de Sesión

Las sesiones son archivos JSONL con estructura de árbol (vinculación id/parentId). El `SessionManager` de Pi maneja la persistencia:

```typescript
const sessionManager = SessionManager.open(params.sessionFile);
```

OpenClaw lo envuelve con `guardSessionManager()` para la seguridad del resultado de herramientas.

### Caché de Sesiones

`session-manager-cache.ts` almacena en caché instancias de SessionManager para evitar el análisis repetido de archivos:

```typescript
await prewarmSessionFile(params.sessionFile);
sessionManager = SessionManager.open(params.sessionFile);
trackSessionManagerAccess(params.sessionFile);
```

### Limitación de Historial

`limitHistoryTurns()` recorta el historial de conversación según el tipo de canal (mensaje directo vs grupo).

### Compactación

La compactación automática se activa en caso de desbordamiento de contexto. `compactEmbeddedPiSessionDirect()` maneja la compactación manual:

```typescript
const compactResult = await compactEmbeddedPiSessionDirect({
  sessionId, sessionFile, provider, model, ...
});
```

## Autenticación y Resolución de Modelos

### Perfiles de Autenticación

OpenClaw mantiene un almacén de perfiles de autenticación con múltiples claves de API por proveedor:

```typescript
const authStore = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
const profileOrder = resolveAuthProfileOrder({ cfg, store: authStore, provider, preferredProfile });
```

Los perfiles rotan en caso de fallos con seguimiento de enfriamiento:

```typescript
await markAuthProfileFailure({ store, profileId, reason, cfg, agentDir });
const rotated = await advanceAuthProfile();
```

### Resolución de Modelos

```typescript
import { resolveModel } from "./pi-embedded-runner/model.js";

const { model, error, authStorage, modelRegistry } = resolveModel(
  provider,
  modelId,
  agentDir,
  config,
);

// Usa el ModelRegistry y AuthStorage de Pi
authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
```

### Failover

`FailoverError` activa el respaldo de modelos cuando está configurado:

```typescript
if (fallbackConfigured && isFailoverErrorMessage(errorText)) {
  throw new FailoverError(errorText, {
    reason: promptFailoverReason ?? "unknown",
    provider,
    model: modelId,
    profileId,
    status: resolveFailoverStatus(promptFailoverReason),
  });
}
```

## Extensiones de Pi

OpenClaw carga extensiones personalizadas de Pi para comportamientos especializados:

### Salvaguarda de Compactación

`pi-extensions/compaction-safeguard.ts` agrega salvaguardas a la compactación, incluyendo presupuestación adaptativa de tokens más resúmenes de fallos de herramientas y operaciones de archivos:

```typescript
if (resolveCompactionMode(params.cfg) === "safeguard") {
  setCompactionSafeguardRuntime(params.sessionManager, { maxHistoryShare });
  paths.push(resolvePiExtensionPath("compaction-safeguard"));
}
```

### Poda de Contexto

`pi-extensions/context-pruning.ts` implementa poda de contexto basada en cache-TTL:

```typescript
if (cfg?.agents?.defaults?.contextPruning?.mode === "cache-ttl") {
  setContextPruningRuntime(params.sessionManager, {
    settings,
    contextWindowTokens,
    isToolPrunable,
    lastCacheTouchAt,
  });
  paths.push(resolvePiExtensionPath("context-pruning"));
}
```

## Streaming y Respuestas de Bloques

### Fragmentación de Bloques

`EmbeddedBlockChunker` gestiona el streaming de texto en bloques de respuesta discretos:

```typescript
const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
```

### Eliminación de Etiquetas de Pensamiento/Final

La salida de streaming se procesa para eliminar bloques `<think>`/`<thinking>` y extraer contenido `<final>`:

```typescript
const stripBlockTags = (text: string, state: { thinking: boolean; final: boolean }) => {
  // Eliminar contenido <think>...</think>
  // Si enforceFinalTag, solo devolver contenido <final>...</final>
};
```

### Directivas de Respuesta

Las directivas de respuesta como `[[media:url]]`, `[[voice]]`, `[[reply:id]]` se analizan y extraen:

```typescript
const { text: cleanedText, mediaUrls, audioAsVoice, replyToId } = consumeReplyDirectives(chunk);
```

## Manejo de Errores

### Clasificación de Errores

`pi-embedded-helpers.ts` clasifica errores para el manejo apropiado:

```typescript
isContextOverflowError(errorText)     // Contexto demasiado grande
isCompactionFailureError(errorText)   // Compactación fallida
isAuthAssistantError(lastAssistant)   // Fallo de autenticación
isRateLimitAssistantError(...)        // Límite de tasa alcanzado
isFailoverAssistantError(...)         // Debería hacer failover
classifyFailoverReason(errorText)     // "auth" | "rate_limit" | "quota" | "timeout" | ...
```

### Respaldo de Nivel de Pensamiento

Si un nivel de pensamiento no es compatible, retrocede:

```typescript
const fallbackThinking = pickFallbackThinkingLevel({
  message: errorText,
  attempted: attemptedThinking,
});
if (fallbackThinking) {
  thinkLevel = fallbackThinking;
  continue;
}
```

## Integración de Sandbox

Cuando el modo sandbox está habilitado, las herramientas y rutas están restringidas:

```typescript
const sandbox = await resolveSandboxContext({
  config: params.config,
  sessionKey: sandboxSessionKey,
  workspaceDir: resolvedWorkspace,
});

if (sandboxRoot) {
  // Usar herramientas read/edit/write en sandbox
  // Exec se ejecuta en contenedor
  // El navegador usa URL de puente
}
```

## Manejo Específico del Proveedor

### Anthropic

- Limpieza de cadena mágica de rechazo
- Validación de turnos para roles consecutivos
- Compatibilidad de parámetros de Claude Code

### Google/Gemini

- Correcciones de orden de turnos (`applyGoogleTurnOrderingFix`)
- Sanitización de esquemas de herramientas (`sanitizeToolsForGoogle`)
- Sanitización de historial de sesiones (`sanitizeSessionHistory`)

### OpenAI

- Herramienta `apply_patch` para modelos Codex
- Manejo de degradación de nivel de pensamiento

## Integración de TUI

OpenClaw también tiene un modo TUI local que usa componentes de pi-tui directamente:

```typescript
// src/tui/tui.ts
import { ... } from "@mariozechner/pi-tui";
```

Esto proporciona la experiencia de terminal interactiva similar al modo nativo de Pi.

## Diferencias Clave con Pi CLI

| Aspecto                    | Pi CLI                                       | OpenClaw Incrustado                                                                           |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Invocación                 | Comando `pi` / RPC                           | SDK vía `createAgentSession()`                                                                |
| Herramientas               | Herramientas de codificación predeterminadas | Suite de herramientas personalizadas de OpenClaw                                              |
| Prompt del sistema         | AGENTS.md + prompts                          | Dinámico por canal/contexto                                                                   |
| Almacenamiento de sesiones | `~/.pi/agent/sessions/`                      | `~/.openclaw/agents/<agentId>/sessions/` (o `$OPENCLAW_STATE_DIR/agents/<agentId>/sessions/`) |
| Autenticación              | Credencial única                             | Multi-perfil con rotación                                                                     |
| Extensiones                | Cargadas desde disco                         | Programáticas + rutas de disco                                                                |
| Manejo de eventos          | Renderizado de TUI                           | Basado en callbacks (onBlockReply, etc.)                                                      |

## Consideraciones Futuras

Áreas para potencial reelaboración:

1. **Alineación de firmas de herramientas**: Actualmente adaptando entre firmas de pi-agent-core y pi-coding-agent
2. **Envoltura del administrador de sesiones**: `guardSessionManager` agrega seguridad pero aumenta la complejidad
3. **Carga de extensiones**: Podría usar el `ResourceLoader` de Pi más directamente
4. **Complejidad del manejador de streaming**: `subscribeEmbeddedPiSession` ha crecido mucho
5. **Peculiaridades de proveedores**: Muchas rutas de código específicas del proveedor que Pi podría manejar potencialmente

## Pruebas

Todas las pruebas existentes que cubren la integración de Pi y sus extensiones:

- `src/agents/pi-embedded-block-chunker.test.ts`
- `src/agents/pi-embedded-helpers.buildbootstrapcontextfiles.test.ts`
- `src/agents/pi-embedded-helpers.classifyfailoverreason.test.ts`
- `src/agents/pi-embedded-helpers.downgradeopenai-reasoning.test.ts`
- `src/agents/pi-embedded-helpers.formatassistanterrortext.test.ts`
- `src/agents/pi-embedded-helpers.formatrawassistanterrorforui.test.ts`
- `src/agents/pi-embedded-helpers.image-dimension-error.test.ts`
- `src/agents/pi-embedded-helpers.image-size-error.test.ts`
- `src/agents/pi-embedded-helpers.isautherrormessage.test.ts`
- `src/agents/pi-embedded-helpers.isbillingerrormessage.test.ts`
- `src/agents/pi-embedded-helpers.iscloudcodeassistformaterror.test.ts`
- `src/agents/pi-embedded-helpers.iscompactionfailureerror.test.ts`
- `src/agents/pi-embedded-helpers.iscontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.isfailovererrormessage.test.ts`
- `src/agents/pi-embedded-helpers.islikelycontextoverflowerror.test.ts`
- `src/agents/pi-embedded-helpers.ismessagingtoolduplicate.test.ts`
- `src/agents/pi-embedded-helpers.messaging-duplicate.test.ts`
- `src/agents/pi-embedded-helpers.normalizetextforcomparison.test.ts`
- `src/agents/pi-embedded-helpers.resolvebootstrapmaxchars.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.keeps-tool-call-tool-result-ids-unchanged.test.ts`
- `src/agents/pi-embedded-helpers.sanitize-session-messages-images.removes-empty-assistant-text-blocks-but-preserves.test.ts`
- `src/agents/pi-embedded-helpers.sanitizegoogleturnordering.test.ts`
- `src/agents/pi-embedded-helpers.sanitizesessionmessagesimages-thought-signature-stripping.test.ts`
- `src/agents/pi-embedded-helpers.sanitizetoolcallid.test.ts`
- `src/agents/pi-embedded-helpers.sanitizeuserfacingtext.test.ts`
- `src/agents/pi-embedded-helpers.stripthoughtsignatures.test.ts`
- `src/agents/pi-embedded-helpers.validate-turns.test.ts`
- `src/agents/pi-embedded-runner-extraparams.live.test.ts` (en vivo)
- `src/agents/pi-embedded-runner-extraparams.test.ts`
- `src/agents/pi-embedded-runner.applygoogleturnorderingfix.test.ts`
- `src/agents/pi-embedded-runner.buildembeddedsandboxinfo.test.ts`
- `src/agents/pi-embedded-runner.createsystempromptoverride.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.falls-back-provider-default-per-dm-not.test.ts`
- `src/agents/pi-embedded-runner.get-dm-history-limit-from-session-key.returns-undefined-sessionkey-is-undefined.test.ts`
- `src/agents/pi-embedded-runner.google-sanitize-thinking.test.ts`
- `src/agents/pi-embedded-runner.guard.test.ts`
- `src/agents/pi-embedded-runner.limithistoryturns.test.ts`
- `src/agents/pi-embedded-runner.resolvesessionagentids.test.ts`
- `src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts`
- `src/agents/pi-embedded-runner.sanitize-session-history.test.ts`
- `src/agents/pi-embedded-runner.splitsdktools.test.ts`
- `src/agents/pi-embedded-runner.test.ts`
- `src/agents/pi-embedded-subscribe.code-span-awareness.test.ts`
- `src/agents/pi-embedded-subscribe.reply-tags.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.calls-onblockreplyflush-before-tool-execution-start-preserve.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-append-text-end-content-is.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-call-onblockreplyflush-callback-is-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-duplicate-text-end-repeats-full.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.does-not-emit-duplicate-block-replies-text.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-block-replies-text-end-does-not.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.emits-reasoning-as-separate-message-enabled.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.filters-final-suppresses-output-without-start-tag.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.includes-canvas-action-metadata-tool-summaries.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-indented-fenced-blocks-intact.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.reopens-fenced-blocks-splitting-inside-them.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.splits-long-single-line-fenced-blocks-reopen.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.streams-soft-chunks-paragraph-preference.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.subscribeembeddedpisession.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.suppresses-message-end-block-replies-message-tool.test.ts`
- `src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.waits-multiple-compaction-retries-before-resolving.test.ts`
- `src/agents/pi-embedded-subscribe.tools.test.ts`
- `src/agents/pi-embedded-utils.test.ts`
- `src/agents/pi-extensions/compaction-safeguard.test.ts`
- `src/agents/pi-extensions/context-pruning.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-tools-agent-config.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-b.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-d.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping-f.test.ts`
- `src/agents/pi-tools.create-openclaw-coding-tools.adds-claude-style-aliases-schemas-without-dropping.test.ts`
- `src/agents/pi-tools.policy.test.ts`
- `src/agents/pi-tools.safe-bins.test.ts`
- `src/agents/pi-tools.workspace-paths.test.ts`
