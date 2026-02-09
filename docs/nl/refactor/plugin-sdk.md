---
summary: "Plan: één schone plugin-SDK + runtime voor alle messaging-connectoren"
read_when:
  - Het definiëren of herstructureren van de plugin-architectuur
  - Het migreren van kanaalconnectoren naar de plugin-SDK/runtime
title: "Plugin-SDK-refactor"
---

# Plugin-SDK + Runtime Refactorplan

Doel: elke messaging-connector is een plugin (gebundeld of extern) die één stabiele API gebruikt.
Geen enkele plugin importeert rechtstreeks uit `src/**`. Alle afhankelijkheden lopen via de SDK of runtime.

## Waarom nu

- Huidige connectoren mixen patronen: directe core-imports, alleen-dist-bridges en aangepaste helpers.
- Dit maakt upgrades kwetsbaar en blokkeert een schoon extern plugin-oppervlak.

## Doelarchitectuur (twee lagen)

### 1. Plugin-SDK (compile-time, stabiel, publiceerbaar)

Scope: types, helpers en config-hulpmiddelen. Geen runtime-status, geen side-effects.

Inhoud (voorbeelden):

- Types: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Config-helpers: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Pairing-helpers: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Onboarding-helpers: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding-types.
- Tool-param-helpers: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Docs-link-helper: `formatDocsLink`.

Levering:

- Publiceer als `openclaw/plugin-sdk` (of exporteer vanuit core onder `openclaw/plugin-sdk`).
- Semver met expliciete stabiliteitsgaranties.

### 2. Plugin-Runtime (uitvoeringsoppervlak, geïnjecteerd)

Scope: alles wat core runtime-gedrag raakt.
Toegankelijk via `OpenClawPluginApi.runtime`, zodat plugins nooit `src/**` importeren.

Voorgesteld oppervlak (minimaal maar compleet):

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

Notities:

- De runtime is de enige manier om core-gedrag te benaderen.
- De SDK is bewust klein en stabiel.
- Elke runtime-methode koppelt aan een bestaande core-implementatie (geen duplicatie).

## Migratieplan (gefaseerd, veilig)

### Fase 0: scaffolding

- Introduceer `openclaw/plugin-sdk`.
- Voeg `api.runtime` toe aan `OpenClawPluginApi` met het bovenstaande oppervlak.
- Behoud bestaande imports tijdens een overgangsperiode (deprecatie-waarschuwingen).

### Fase 1: bridge-opschoning (laag risico)

- Vervang per-extensie `core-bridge.ts` door `api.runtime`.
- Migreer BlueBubbles, Zalo, Zalo Personal eerst (al dichtbij).
- Verwijder gedupliceerde bridge-code.

### Fase 2: lichte direct-import-plugins

- Migreer Matrix naar SDK + runtime.
- Valideer onboarding-, directory- en group-mention-logica.

### Fase 3: zware direct-import-plugins

- Migreer Microsoft Teams (grootste set runtime-helpers).
- Zorg dat reply-/typing-semantiek overeenkomt met huidig gedrag.

### Fase 4: iMessage-pluginisatie

- Verplaats iMessage naar `extensions/imessage`.
- Vervang directe core-calls door `api.runtime`.
- Behoud config-sleutels, CLI-gedrag en documentatie intact.

### Fase 5: handhaving

- Voeg lintregel / CI-check toe: geen `extensions/**`-imports vanuit `src/**`.
- Voeg compatibiliteitschecks toe voor plugin-SDK/versie (runtime + SDK semver).

## Compatibiliteit en versionering

- SDK: semver, gepubliceerd, gedocumenteerde wijzigingen.
- Runtime: geversioneerd per core-release. Voeg `api.runtime.version` toe.
- Plugins declareren een vereiste runtime-range (bijv. `openclawRuntime: ">=2026.2.0"`).

## Teststrategie

- Adapter-niveau unittests (runtime-functies getest met echte core-implementatie).
- Golden tests per plugin: waarborg geen gedragsafwijking (routing, pairing, toegestane lijst, mention-gating).
- Eén end-to-end plugin-voorbeeld gebruikt in CI (installeren + uitvoeren + smoke).

## Open vragen

- Waar SDK-types hosten: apart pakket of core-export?
- Distributie van runtime-types: in SDK (alleen types) of in core?
- Hoe docs-links blootstellen voor gebundelde versus externe plugins?
- Staan we beperkte directe core-imports toe voor in-repo plugins tijdens de overgang?

## Succescriteria

- Alle kanaalconnectoren zijn plugins die SDK + runtime gebruiken.
- Geen `extensions/**`-imports vanuit `src/**`.
- Nieuwe connector-templates hangen alleen af van SDK + runtime.
- Externe plugins kunnen worden ontwikkeld en bijgewerkt zonder toegang tot de core-broncode.

Gerelateerde documentatie: [Plugins](/tools/plugin), [Kanalen](/channels/index), [Configuratie](/gateway/configuration).
