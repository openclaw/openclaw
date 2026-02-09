---
summary: "Plan: jeden czysty SDK wtyczek + runtime dla wszystkich konektorów komunikacyjnych"
read_when:
  - Definiowanie lub refaktoryzacja architektury wtyczek
  - Migracja konektorów kanałów do SDK/runtime wtyczek
title: "Refaktoryzacja SDK wtyczek"
---

# Plan refaktoryzacji SDK + Runtime wtyczek

Cel: każdy konektor komunikacyjny jest wtyczką (dołączoną lub zewnętrzną) korzystającą z jednego stabilnego API.
Żadna wtyczka nie importuje bezpośrednio `src/**`. Wszystkie zależności przechodzą przez SDK lub runtime.

## Dlaczego teraz

- Obecne konektory mieszają wzorce: bezpośrednie importy z core, mosty tylko dla dist oraz niestandardowe pomocniki.
- To czyni aktualizacje kruchymi i blokuje czystą, zewnętrzną powierzchnię wtyczek.

## Docelowa architektura (dwie warstwy)

### 1. SDK wtyczek (czas kompilacji, stabilne, publikowalne)

Zakres: typy, pomocniki i narzędzia konfiguracji. Brak stanu runtime, brak efektów ubocznych.

Zawartość (przykłady):

- Typy: `ChannelPlugin`, adaptery, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Pomocniki konfiguracji: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Pomocniki parowania: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Pomocniki onboardingu: `promptChannelAccessConfig`, `addWildcardAllowFrom`, typy onboardingu.
- Pomocniki parametrów narzędzi: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Pomocnik linków do dokumentacji: `formatDocsLink`.

Dostawa:

- Publikowane jako `openclaw/plugin-sdk` (lub eksportowane z core pod `openclaw/plugin-sdk`).
- Semver z jednoznacznymi gwarancjami stabilności.

### 2. Runtime wtyczek (powierzchnia wykonawcza, wstrzykiwana)

Zakres: wszystko, co dotyka zachowania runtime core.
Dostępne przez `OpenClawPluginApi.runtime`, aby wtyczki nigdy nie importowały `src/**`.

Proponowana powierzchnia (minimalna, ale kompletna):

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

Uwagi:

- Runtime jest jedynym sposobem dostępu do zachowania core.
- SDK jest celowo małe i stabilne.
- Każda metoda runtime mapuje się na istniejącą implementację core (bez duplikacji).

## Plan migracji (fazowy, bezpieczny)

### Faza 0: rusztowanie

- Wprowadzić `openclaw/plugin-sdk`.
- Dodać `api.runtime` do `OpenClawPluginApi` z powyższą powierzchnią.
- Utrzymać istniejące importy w oknie przejściowym (ostrzeżenia o deprecjacji).

### Faza 1: porządkowanie mostów (niskie ryzyko)

- Zastąpić per‑rozszerzenie `core-bridge.ts` przez `api.runtime`.
- Najpierw migrować BlueBubbles, Zalo, Zalo Personal (już blisko).
- Usunąć zduplikowany kod mostów.

### Faza 2: lekkie wtyczki z bezpośrednimi importami

- Migrować Matrix do SDK + runtime.
- Zweryfikować onboarding, katalog i logikę wzmianek grupowych.

### Faza 3: ciężkie wtyczki z bezpośrednimi importami

- Migrować MS Teams (największy zestaw pomocników runtime).
- Upewnić się, że semantyka odpowiedzi/wskaźników pisania odpowiada obecnemu zachowaniu.

### Faza 4: „pluginizacja” iMessage

- Przenieść iMessage do `extensions/imessage`.
- Zastąpić bezpośrednie wywołania core przez `api.runtime`.
- Zachować klucze konfiguracji, zachowanie CLI i dokumentację bez zmian.

### Faza 5: egzekwowanie

- Dodać regułę lint / sprawdzenie CI: brak importów `extensions/**` z `src/**`.
- Dodać sprawdzanie kompatybilności wersji SDK/wtyczek (runtime + semver SDK).

## Zgodność i wersjonowanie

- SDK: semver, publikowane, udokumentowane zmiany.
- Runtime: wersjonowane per wydanie core. Dodać `api.runtime.version`.
- Wtyczki deklarują wymagany zakres runtime (np. `openclawRuntime: ">=2026.2.0"`).

## Strategia testów

- Testy jednostkowe na poziomie adapterów (funkcje runtime ćwiczone z rzeczywistą implementacją core).
- Testy „golden” per wtyczka: brak dryfu zachowania (routing, parowanie, lista dozwolonych, bramkowanie wzmianek).
- Jedna przykładowa wtyczka end‑to‑end używana w CI (instalacja + uruchomienie + test dymny).

## Otwarte pytania

- Gdzie hostować typy SDK: osobny pakiet czy eksport z core?
- Dystrybucja typów runtime: w SDK (tylko typy) czy w core?
- Jak udostępniać linki do dokumentacji dla wtyczek dołączonych vs zewnętrznych?
- Czy dopuszczamy ograniczone bezpośrednie importy core dla wtyczek w repozytorium w trakcie przejścia?

## Kryteria sukcesu

- Wszystkie konektory kanałów są wtyczkami używającymi SDK + runtime.
- Brak importów `extensions/**` z `src/**`.
- Nowe szablony konektorów zależą wyłącznie od SDK + runtime.
- Zewnętrzne wtyczki mogą być rozwijane i aktualizowane bez dostępu do źródeł core.

Powiązana dokumentacja: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
