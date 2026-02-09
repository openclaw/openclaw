---
summary: "Plan: ett rent plugin-SDK + runtime för alla meddelandekopplingar"
read_when:
  - Definierar eller refaktorerar plugin-arkitekturen
  - Migrerar kanalkopplingar till plugin-SDK/runtime
title: "Refaktorering av plugin-SDK"
---

# Plan för refaktorering av Plugin SDK + Runtime

Mål: varje meddelandekontakt är en plugin (medföljande eller externt) med ett stabilt API.
Ingen plugin import från `src/**` direkt. Alla beroenden går via SDK eller runtime.

## Varför nu

- Nuvarande kopplingar blandar mönster: direkta kärnimporter, bryggor som bara finns i dist, och anpassade hjälpare.
- Detta gör uppgraderingar sköra och blockerar en ren extern plugin-yta.

## Målarkitektur (två lager)

### 1. Plugin SDK (kompileringstid, stabilt, publicerbart)

Omfattning: typer, hjälpare och konfigurationsverktyg. Ingen körtid tillstånd, inga biverkningar.

Innehåll (exempel):

- Typer: `ChannelPlugin`, adaptrar, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Konfig-hjälpare: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Parkopplingshjälpare: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Introduktionshjälpare: `promptChannelAccessConfig`, `addWildcardAllowFrom`, introduktionstyper.
- Verktygsparam-hjälpare: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Dokumentlänkhjälpare: `formatDocsLink`.

Leverans:

- Publicera som `openclaw/plugin-sdk` (eller exportera från core under `openclaw/plugin-sdk`).
- Semver med explicita stabilitetsgarantier.

### 2. Plugin Runtime (exekveringsyta, injicerad)

Omfattning: allt som berör grundläggande runtime-beteende.
Åtkomna via `OpenClawPluginApi.runtime` så plugins importerar aldrig `src/**`.

Föreslagen yta (minimal men komplett):

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

Noteringar:

- Runtime är det enda sättet att komma åt kärnbeteende.
- SDK:t är avsiktligt litet och stabilt.
- Varje runtime-metod mappar till en befintlig kärnimplementation (ingen duplicering).

## Migrationsplan (fasindelad, säker)

### Fas 0: uppbyggnad

- Introducera `openclaw/plugin-sdk`.
- Lägg till `api.runtime` i `OpenClawPluginApi` med ytan ovan.
- Behåll befintliga importer under ett övergångsfönster (avvecklingsvarningar).

### Fas 1: bryggrensning (låg risk)

- Ersätt per‑tillägg `core-bridge.ts` med `api.runtime`.
- Migrera BlueBubbles, Zalo, Zalo Personal först (redan nära).
- Ta bort duplicerad bryggkod.

### Fas 2: plugins med lätta direkta importer

- Migrera Matrix till SDK + runtime.
- Validera introduktion, katalog och logik för gruppomnämnanden.

### Fas 3: plugins med tunga direkta importer

- Migrera MS Teams (största uppsättningen runtime-hjälpare).
- Säkerställ att svar-/skrivningssemantik matchar nuvarande beteende.

### Fas 4: pluginisering av iMessage

- Flytta iMessage till `extensions/imessage`.
- Ersätt direkta kärnanrop med `api.runtime`.
- Behåll konfig-nycklar, CLI-beteende och dokumentation intakta.

### Fas 5: efterlevnad

- Lägg till lint‑regel / CI‑kontroll: inga `extensions/**`‑importer från `src/**`.
- Lägg till kompatibilitetskontroller för plugin‑SDK/version (runtime + SDK semver).

## Kompatibilitet och versionshantering

- SDK: semver, publicerade och dokumenterade ändringar.
- Körtid: versionerad per kärnutgåva. Lägg till `api.runtime.version`.
- Plugins deklarerar ett obligatoriskt runtime-intervall (t.ex., `openclawRuntime: ">=2026.2.0"`).

## Teststrategi

- Enhetstester på adapternivå (runtime‑funktioner körda med riktig kärnimplementation).
- Golden‑tester per plugin: säkerställ ingen beteendedrift (routing, parkoppling, tillåtelselista, omnämnandespärr).
- Ett enda end‑to‑end‑pluginexempel som används i CI (installera + köra + smoke).

## Öppna frågor

- Var ska SDK‑typerna ligga: separat paket eller core‑export?
- Distribution av runtime‑typer: i SDK:t (endast typer) eller i core?
- Hur exponeras dokumentlänkar för paketerade kontra externa plugins?
- Tillåter vi begränsade direkta kärnimporter för plugins i repo under övergången?

## Framgångskriterier

- Alla kanalkopplingar är plugins som använder SDK + runtime.
- Inga `extensions/**`‑importer från `src/**`.
- Nya mallar för kopplingar beror endast på SDK + runtime.
- Externa plugins kan utvecklas och uppdateras utan åtkomst till core‑källkod.

Relaterad dokumentation: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
