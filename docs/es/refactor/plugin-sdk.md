---
summary: "Plan: un SDK de plugins limpio + runtime para todos los conectores de mensajería"
read_when:
  - Definir o refactorizar la arquitectura de plugins
  - Migrar conectores de canal al SDK/runtime de plugins
title: "Refactorización del SDK de Plugins"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:34:31Z
---

# Plan de refactorización del SDK + Runtime de Plugins

Objetivo: cada conector de mensajería es un plugin (integrado o externo) que usa una API estable.
Ningún plugin importa directamente desde `src/**`. Todas las dependencias pasan por el SDK o el runtime.

## Por qué ahora

- Los conectores actuales mezclan patrones: importaciones directas del core, puentes solo de distribución y helpers personalizados.
- Esto vuelve frágiles las actualizaciones y bloquea una superficie limpia para plugins externos.

## Arquitectura objetivo (dos capas)

### 1) SDK de Plugins (tiempo de compilación, estable, publicable)

Alcance: tipos, helpers y utilidades de configuración. Sin estado en runtime, sin efectos secundarios.

Contenido (ejemplos):

- Tipos: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Helpers de configuración: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Helpers de emparejamiento: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Helpers de onboarding: `promptChannelAccessConfig`, `addWildcardAllowFrom`, tipos de onboarding.
- Helpers de parámetros de herramientas: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Helper de enlace a docs: `formatDocsLink`.

Entrega:

- Publicar como `openclaw/plugin-sdk` (o exportar desde el core bajo `openclaw/plugin-sdk`).
- Semver con garantías explícitas de estabilidad.

### 2) Runtime de Plugins (superficie de ejecución, inyectado)

Alcance: todo lo que toca el comportamiento del runtime del core.
Se accede vía `OpenClawPluginApi.runtime` para que los plugins nunca importen `src/**`.

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
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows
    };
    routing: {
      resolveAgentRoute(params: {
        cfg: unknown;
        channel: string;
        accountId: string;
        peer: { kind: "dm" | "group" | "channel"; id: string };
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

- El runtime es la única forma de acceder al comportamiento del core.
- El SDK es intencionalmente pequeño y estable.
- Cada método del runtime mapea a una implementación existente del core (sin duplicación).

## Plan de migración (por fases, seguro)

### Fase 0: andamiaje

- Introducir `openclaw/plugin-sdk`.
- Agregar `api.runtime` a `OpenClawPluginApi` con la superficie anterior.
- Mantener importaciones existentes durante una ventana de transición (advertencias de deprecación).

### Fase 1: limpieza de puentes (bajo riesgo)

- Reemplazar `core-bridge.ts` por extensión con `api.runtime`.
- Migrar primero BlueBubbles, Zalo, Zalo Personal (ya están cerca).
- Eliminar código de puente duplicado.

### Fase 2: plugins con importaciones directas ligeras

- Migrar Matrix a SDK + runtime.
- Validar onboarding, directorio y lógica de menciones de grupos.

### Fase 3: plugins con importaciones directas pesadas

- Migrar MS Teams (el mayor conjunto de helpers de runtime).
- Asegurar que la semántica de respuestas/escritura coincida con el comportamiento actual.

### Fase 4: pluginización de iMessage

- Mover iMessage a `extensions/imessage`.
- Reemplazar llamadas directas al core con `api.runtime`.
- Mantener intactas las claves de configuración, el comportamiento de la CLI y la documentación.

### Fase 5: aplicación de reglas

- Agregar regla de lint / verificación de CI: no importaciones `extensions/**` desde `src/**`.
- Agregar verificaciones de compatibilidad de SDK/versión de plugins (semver de runtime + SDK).

## Compatibilidad y versionado

- SDK: semver, cambios publicados y documentados.
- Runtime: versionado por lanzamiento del core. Agregar `api.runtime.version`.
- Los plugins declaran un rango de runtime requerido (p. ej., `openclawRuntime: ">=2026.2.0"`).

## Estrategia de pruebas

- Pruebas unitarias a nivel de adapter (funciones del runtime ejercidas con la implementación real del core).
- Pruebas golden por plugin: asegurar que no haya desviaciones de comportamiento (enrutamiento, emparejamiento, lista de permitidos, control de menciones).
- Un único plugin de ejemplo de extremo a extremo usado en CI (instalar + ejecutar + smoke).

## Preguntas abiertas

- ¿Dónde alojar los tipos del SDK: paquete separado o exportación del core?
- Distribución de tipos del runtime: ¿en el SDK (solo tipos) o en el core?
- ¿Cómo exponer enlaces a docs para plugins integrados vs externos?
- ¿Permitimos importaciones directas limitadas del core para plugins en el repo durante la transición?

## Criterios de éxito

- Todos los conectores de canal son plugins que usan SDK + runtime.
- Ninguna importación `extensions/**` desde `src/**`.
- Las plantillas de nuevos conectores dependen solo del SDK + runtime.
- Los plugins externos pueden desarrollarse y actualizarse sin acceso al código fuente del core.

Docs relacionados: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
