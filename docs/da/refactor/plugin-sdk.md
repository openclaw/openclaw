---
summary: "Plan: ét rent plugin-SDK + runtime til alle beskedforbindelser"
read_when:
  - Definering eller refaktorering af plugin-arkitekturen
  - Migrering af kanalconnectors til plugin-SDK/runtime
title: "Refaktorering af Plugin SDK"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:40Z
---

# Plugin SDK + Runtime Refaktoreringsplan

Mål: hver beskedconnector er et plugin (medfølgende eller eksternt), der bruger ét stabilt API.
Ingen plugins importerer direkte fra `src/**`. Alle afhængigheder går via SDK’et eller runtime.

## Hvorfor nu

- Nuværende connectors blander mønstre: direkte core-imports, dist-only bridges og brugerdefinerede hjælpere.
- Det gør opgraderinger skrøbelige og blokerer en ren ekstern plugin-overflade.

## Målarkitektur (to lag)

### 1) Plugin SDK (kompileringstid, stabilt, publicerbart)

Omfang: typer, hjælpere og konfigurationsværktøjer. Ingen runtime-tilstand, ingen sideeffekter.

Indhold (eksempler):

- Typer: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Konfigurationshjælpere: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Parringshjælpere: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Onboarding-hjælpere: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding-typer.
- Værktøjsparameter-hjælpere: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Hjælper til dokumentationslinks: `formatDocsLink`.

Levering:

- Publicér som `openclaw/plugin-sdk` (eller eksportér fra core under `openclaw/plugin-sdk`).
- Semver med eksplicitte stabilitetsgarantier.

### 2) Plugin Runtime (eksekveringsflade, injiceret)

Omfang: alt der berører core-runtime-adfærd.
Tilgås via `OpenClawPluginApi.runtime`, så plugins aldrig importerer `src/**`.

Foreslået overflade (minimal men komplet):

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

Noter:

- Runtime er den eneste måde at få adgang til core-adfærd.
- SDK’et er bevidst lille og stabilt.
- Hver runtime-metode mapper til en eksisterende core-implementering (ingen duplikering).

## Migreringsplan (faseopdelt, sikker)

### Fase 0: stillads

- Introducér `openclaw/plugin-sdk`.
- Tilføj `api.runtime` til `OpenClawPluginApi` med overfladen ovenfor.
- Bevar eksisterende imports i en overgangsperiode (deprecations-advarsler).

### Fase 1: oprydning af bridges (lav risiko)

- Erstat per-udvidelse `core-bridge.ts` med `api.runtime`.
- Migrér BlueBubbles, Zalo, Zalo Personal først (allerede tæt på).
- Fjern duplikeret bridge-kode.

### Fase 2: lette plugins med direkte imports

- Migrér Matrix til SDK + runtime.
- Valider onboarding-, katalog- og gruppemention-logik.

### Fase 3: tunge plugins med direkte imports

- Migrér MS Teams (største sæt af runtime-hjælpere).
- Sikr at svar-/typing-semantik matcher nuværende adfærd.

### Fase 4: iMessage-pluginisering

- Flyt iMessage ind i `extensions/imessage`.
- Erstat direkte core-kald med `api.runtime`.
- Bevar konfigurationsnøgler, CLI-adfærd og dokumentation intakt.

### Fase 5: håndhævelse

- Tilføj lint-regel / CI-tjek: ingen `extensions/**`-imports fra `src/**`.
- Tilføj kompatibilitetstjek for plugin SDK/version (runtime + SDK semver).

## Kompatibilitet og versionering

- SDK: semver, publiceret, dokumenterede ændringer.
- Runtime: versioneret pr. core-release. Tilføj `api.runtime.version`.
- Plugins erklærer et påkrævet runtime-interval (f.eks. `openclawRuntime: ">=2026.2.0"`).

## Teststrategi

- Adapter-niveau unit-tests (runtime-funktioner afprøvet med reel core-implementering).
- Golden tests pr. plugin: sikr ingen adfærdsafvigelse (routing, parring, tilladelsesliste, mention-gating).
- Ét samlet end-to-end plugin-eksempel brugt i CI (installér + kør + smoke).

## Åbne spørgsmål

- Hvor skal SDK-typer hostes: separat pakke eller core-eksport?
- Distribution af runtime-typer: i SDK (kun typer) eller i core?
- Hvordan eksponeres dokumentationslinks for medfølgende vs. eksterne plugins?
- Tillader vi begrænsede direkte core-imports for in-repo plugins under overgangen?

## Succeskriterier

- Alle kanalconnectors er plugins, der bruger SDK + runtime.
- Ingen `extensions/**`-imports fra `src/**`.
- Nye connector-skabeloner afhænger kun af SDK + runtime.
- Eksterne plugins kan udvikles og opdateres uden adgang til core-kildekode.

Relaterede dokumenter: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
