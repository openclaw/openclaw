---
summary: "Plan: un SDK de plugin limpio + runtime para todos los conectores de mensajería"
read_when:
  - Definiendo o refactorizando la arquitectura de plugins
  - Migrando conectores de canales al SDK/runtime de plugins
title: "Refactorización de SDK de Plugin"
---

# Plan de refactorización de SDK de Plugin + Runtime

Objetivo: cada conector de mensajería es un plugin (incluido o externo) usando una API estable.
Ningún plugin importa de `src/**` directamente. Todas las dependencias pasan por el SDK o runtime.

## Por qué ahora

- Los conectores actuales mezclan patrones: importaciones directas del core, puentes solo-dist, y helpers personalizados.
- Esto hace que las actualizaciones sean frágiles y bloquea una superficie de plugin externo limpia.

## Arquitectura objetivo (dos capas)

### 1) SDK de Plugin (tiempo de compilación, estable, publicable)

Alcance: tipos, helpers, y utilidades de config. Sin estado de runtime, sin efectos secundarios.

Contenidos (ejemplos):

- Tipos: `ChannelPlugin`, adaptadores, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Helpers de config: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Helpers de emparejamiento: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Helpers de incorporación: `promptChannelAccessConfig`, `addWildcardAllowFrom`, tipos de incorporación.
- Helpers de parámetros de herramienta: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Helper de enlace de docs: `formatDocsLink`.

Entrega:

- Publicar como `openclaw/plugin-sdk` (o exportar del core bajo `openclaw/plugin-sdk`).
- Semver con garantías de estabilidad explícitas.

### 2) Runtime de Plugin (superficie de ejecución, inyectada)

Alcance: todo lo que toca el comportamiento del runtime core.
Accedido vía `OpenClawPluginApi.runtime` para que los plugins nunca importen `src/**`.

Superficie propuesta (mínima pero completa):

```ts
export type PluginRuntime = {
  channel: {
    text: {
      chunkMarkdownText(text: string, limit: number): string[];
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;
    };
    reply: {
      dispatchReplyWithBufferedBlockDispatcher(params: {
        ctx: unknown;
        cfg: unknown;
        dispatcherOptions: {
          deliver: (payload: {
            text?: string;
            mediaUrls?: string[];
            mediaUrl?: string;
          }) => void | Promise<void>;
          onError?: (err: unknown, info: { kind: string }) => void;
        };
      }): Promise<void>;
      createReplyDispatcherWithTyping?: unknown; // adaptador para flujos estilo Teams
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: RoutePeerKind; id: string };
      }): { sessionKey: string; accountId: string };
    };
    pairing: {
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;
      readAllowFromStore(channel: string): Promise<string[]>;
      upsertPairingRequest(params: {
        channel: string;
        id: string;
        meta?: { name?: string };
      }): Promise<{ code: string; created: boolean }>;
    };
    media: {
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;
      saveMediaBuffer(
        buffer: Uint8Array,
        contentType: string | undefined,
        direction: "inbound" | "outbound",
        maxBytes: number,
      ): Promise<{ path: string; contentType?: string }>;
    };
    mentions: {
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;
    };
    groups: {
      resolveGroupPolicy(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
      ): {
        allowlistEnabled: boolean;
        allowed: boolean;
        groupConfig?: unknown;
        defaultConfig?: unknown;
      };
      resolveRequireMention(
        cfg: OpenClawConfig,
        channel: string,
        accountId: string,
        groupId: string,
        override?: boolean,
      ): boolean;
    };
    debounce: {
      createInboundDebouncer<T>(opts: {
        debounceMs: number;
        buildKey: (v: T) => string | null;
        shouldDebounce: (v: T) => boolean;
        onFlush: (entries: T[]) => Promise<void>;
        onError?: (err: unknown) => void;
      }): { push: (v: T) => void; flush: () => Promise<void> };
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;
    };
    commands: {
      resolveCommandAuthorizedFromAuthorizers(params: {
        useAccessGroups: boolean;
        authorizers: Array<{ configured: boolean; allowed: boolean }>;
      }): boolean;
    };
  };
  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name: string): PluginLogger;
  };
  state: {
    resolveStateDir(cfg: OpenClawConfig): string;
  };
};
```

Notas:

- Runtime es la única forma de acceder al comportamiento core.
- SDK es intencionalmente pequeño y estable.
- Cada método de runtime mapea a una implementación core existente (sin duplicación).

## Plan de migración (por fases, seguro)

### Fase 0: andamiaje

- Introducir `openclaw/plugin-sdk`.
- Agregar `api.runtime` a `OpenClawPluginApi` con la superficie anterior.
- Mantener importaciones existentes durante una ventana de transición (advertencias de deprecación).

### Fase 1: limpieza de puentes (bajo riesgo)

- Reemplazar `core-bridge.ts` por extensión con `api.runtime`.
- Migrar BlueBubbles, Zalo, Zalo Personal primero (ya cercanos).
- Eliminar código de puente duplicado.

### Fase 2: plugins de importación directa ligeros

- Migrar Matrix a SDK + runtime.
- Validar incorporación, directorio, lógica de mención de grupo.

### Fase 3: plugins de importación directa pesados

- Migrar MS Teams (conjunto más grande de helpers de runtime).
- Asegurar que la semántica de respuesta/escritura coincida con el comportamiento actual.

### Fase 4: pluginización de iMessage

- Mover iMessage a `extensions/imessage`.
- Reemplazar llamadas directas al core con `api.runtime`.
- Mantener claves de config, comportamiento CLI, y docs intactos.

### Fase 5: aplicación

- Agregar regla de lint / verificación CI: sin importaciones de `extensions/**` desde `src/**`.
- Agregar verificaciones de compatibilidad de SDK/versión de plugin (runtime + semver SDK).

## Compatibilidad y versionado

- SDK: semver, publicado, cambios documentados.
- Runtime: versionado por lanzamiento core. Agregar `api.runtime.version`.
- Los plugins declaran un rango de runtime requerido (ej., `openclawRuntime: ">=2026.2.0"`).

## Estrategia de pruebas

- Pruebas unitarias a nivel de adaptador (funciones de runtime ejercitadas con implementación core real).
- Pruebas doradas por plugin: asegurar que no haya deriva de comportamiento (enrutamiento, emparejamiento, lista permitida, puerta de mención).
- Una sola muestra de plugin end-to-end usada en CI (instalar + ejecutar + smoke).

## Preguntas abiertas

- ¿Dónde hospedar tipos de SDK: paquete separado o exportación core?
- Distribución de tipos de runtime: ¿en SDK (solo tipos) o en core?
- ¿Cómo exponer enlaces de docs para plugins incluidos vs externos?
- ¿Permitimos importaciones directas core limitadas para plugins en repo durante la transición?

## Criterios de éxito

- Todos los conectores de canales son plugins usando SDK + runtime.
- Sin importaciones de `extensions/**` desde `src/**`.
- Las plantillas de nuevos conectores dependen solo de SDK + runtime.
- Los plugins externos pueden ser desarrollados y actualizados sin acceso al código fuente core.

Documentos relacionados: [Plugins](/es-ES/tools/plugin), [Canales](/es-ES/channels/index), [Configuración](/es-ES/gateway/configuration).
