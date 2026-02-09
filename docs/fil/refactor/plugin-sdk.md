---
summary: "Plano: isang malinis na plugin SDK + runtime para sa lahat ng messaging connector"
read_when:
  - Pagtukoy o pagre-refactor ng plugin architecture
  - Pag-migrate ng mga channel connector papunta sa plugin SDK/runtime
title: "Refactor ng Plugin SDK"
---

# Plugin SDK + Runtime Refactor Plan

38. Layunin: bawat messaging connector ay isang plugin (bundled o external) na gumagamit ng isang stable na API.
39. Walang plugin ang dapat mag-import nang direkta mula sa `src/**`. 40. Lahat ng dependency ay dumadaan sa SDK o runtime.

## Bakit ngayon

- Hinahalo ng kasalukuyang mga connector ang iba’t ibang pattern: direktang core imports, dist-only bridges, at mga custom helper.
- Ginagawa nitong marupok ang mga upgrade at hinahadlangan ang isang malinis na external plugin surface.

## Target na arkitektura (dalawang layer)

### 1. Plugin SDK (compile-time, stable, publishable)

41. Saklaw: mga type, helper, at config utility. 42. Walang runtime state, walang side effect.

Mga nilalaman (mga halimbawa):

- Mga Type: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.
- Mga Config helper: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,
  `applyAccountNameToChannelSection`.
- Mga Pairing helper: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.
- Mga Onboarding helper: `promptChannelAccessConfig`, `addWildcardAllowFrom`, mga onboarding type.
- Mga Tool param helper: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.
- Docs link helper: `formatDocsLink`.

Delivery:

- I-publish bilang `openclaw/plugin-sdk` (o i-export mula sa core sa ilalim ng `openclaw/plugin-sdk`).
- Semver na may malinaw na garantiya sa stability.

### 2. Plugin Runtime (execution surface, injected)

43. Saklaw: lahat ng humahawak sa core runtime behavior.
44. Ina-access sa pamamagitan ng `OpenClawPluginApi.runtime` upang ang mga plugin ay hindi kailanman mag-import ng `src/**`.

Iminungkahing surface (minimal ngunit kumpleto):

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

Mga tala:

- Ang runtime lamang ang paraan para ma-access ang core behavior.
- Ang SDK ay sadyang maliit at stable.
- Ang bawat runtime method ay tumutugma sa isang umiiral na core implementation (walang duplication).

## Migration plan (phased, ligtas)

### Phase 0: scaffolding

- Ipakilala ang `openclaw/plugin-sdk`.
- Idagdag ang `api.runtime` sa `OpenClawPluginApi` gamit ang surface sa itaas.
- Panatilihin ang mga umiiral na import sa loob ng transition window (may mga deprecation warning).

### Phase 1: bridge cleanup (mababang risk)

- Palitan ang bawat-extension na `core-bridge.ts` ng `api.runtime`.
- I-migrate muna ang BlueBubbles, Zalo, Zalo Personal (malapit na sa target).
- Alisin ang mga nadobleng bridge code.

### Phase 2: light direct-import plugins

- I-migrate ang Matrix papunta sa SDK + runtime.
- I-validate ang onboarding, directory, at group mention logic.

### Phase 3: heavy direct-import plugins

- I-migrate ang MS Teams (pinakamalaking set ng runtime helper).
- Tiyaking tumutugma ang reply/typing semantics sa kasalukuyang behavior.

### Phase 4: iMessage pluginization

- Ilipat ang iMessage papunta sa `extensions/imessage`.
- Palitan ang mga direktang core call ng `api.runtime`.
- Panatilihing buo ang mga config key, CLI behavior, at docs.

### Phase 5: enforcement

- Magdagdag ng lint rule / CI check: walang `extensions/**` imports mula sa `src/**`.
- Magdagdag ng plugin SDK/version compatibility checks (runtime + SDK semver).

## Compatibility at versioning

- SDK: semver, published, may dokumentadong pagbabago.
- 45. Runtime: versioned kada core release. 46. Idagdag ang `api.runtime.version`.
- Nagdedeklara ang mga plugin ng kinakailangang runtime range (hal., `openclawRuntime: ">=2026.2.0"`).

## Testing strategy

- Mga unit test sa adapter level (ang mga runtime function ay tine-test gamit ang tunay na core implementation).
- Golden tests bawat plugin: tiyaking walang behavior drift (routing, pairing, allowlist, mention gating).
- Isang end-to-end na plugin sample na ginagamit sa CI (install + run + smoke).

## Mga bukas na tanong

- Saan iho-host ang SDK types: hiwalay na package o core export?
- Runtime type distribution: sa SDK (types lang) o sa core?
- Paano ilalantad ang mga docs link para sa bundled vs external na plugin?
- Papayagan ba ang limitadong direktang core import para sa mga in-repo plugin habang nasa transition?

## Mga pamantayan ng tagumpay

- Lahat ng channel connector ay mga plugin na gumagamit ng SDK + runtime.
- Walang `extensions/**` imports mula sa `src/**`.
- Ang mga bagong connector template ay umaasa lamang sa SDK + runtime.
- Maaaring idevelop at i-update ang mga external plugin nang walang access sa core source.

Kaugnay na docs: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).
