---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Plan: one clean plugin SDK + runtime for all messaging connectors"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Defining or refactoring the plugin architecture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Migrating channel connectors to the plugin SDK/runtime（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Plugin SDK Refactor"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Plugin SDK + Runtime Refactor Plan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Goal: every messaging connector is a plugin (bundled or external) using one stable API.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No plugin imports from `src/**` directly. All dependencies go through the SDK or runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Why now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Current connectors mix patterns: direct core imports, dist-only bridges, and custom helpers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This makes upgrades brittle and blocks a clean external plugin surface.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Target architecture (two layers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Plugin SDK (compile-time, stable, publishable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scope: types, helpers, and config utilities. No runtime state, no side effects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Contents (examples):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Types: `ChannelPlugin`, adapters, `ChannelMeta`, `ChannelCapabilities`, `ChannelDirectoryEntry`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config helpers: `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`, `deleteAccountFromConfigSection`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `applyAccountNameToChannelSection`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing helpers: `PAIRING_APPROVED_MESSAGE`, `formatPairingApproveHint`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding helpers: `promptChannelAccessConfig`, `addWildcardAllowFrom`, onboarding types.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tool param helpers: `createActionGate`, `readStringParam`, `readNumberParam`, `readReactionParams`, `jsonResult`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs link helper: `formatDocsLink`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delivery:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Publish as `openclaw/plugin-sdk` (or export from core under `openclaw/plugin-sdk`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Semver with explicit stability guarantees.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Plugin Runtime (execution surface, injected)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scope: everything that touches core runtime behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Accessed via `OpenClawPluginApi.runtime` so plugins never import `src/**`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Proposed surface (minimal but complete):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```ts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export type PluginRuntime = {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channel: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    text: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      chunkMarkdownText(text: string, limit: number): string[];（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      resolveTextChunkLimit(cfg: OpenClawConfig, channel: string, accountId?: string): number;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      hasControlCommand(text: string, cfg: OpenClawConfig): boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reply: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      dispatchReplyWithBufferedBlockDispatcher(params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ctx: unknown;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cfg: unknown;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        dispatcherOptions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          deliver: (payload: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            text?: string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            mediaUrls?: string[];（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            mediaUrl?: string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          }) => void | Promise<void>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          onError?: (err: unknown, info: { kind: string }) => void;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }): Promise<void>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      createReplyDispatcherWithTyping?: unknown; // adapter for Teams-style flows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    routing: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      resolveAgentRoute(params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cfg: unknown;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId: string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        peer: { kind: RoutePeerKind; id: string };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }): { sessionKey: string; accountId: string };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    pairing: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      buildPairingReply(params: { channel: string; idLine: string; code: string }): string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      readAllowFromStore(channel: string): Promise<string[]>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      upsertPairingRequest(params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        meta?: { name?: string };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }): Promise<{ code: string; created: boolean }>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    media: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      fetchRemoteMedia(params: { url: string }): Promise<{ buffer: Buffer; contentType?: string }>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      saveMediaBuffer(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        buffer: Uint8Array,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        contentType: string | undefined,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        direction: "inbound" | "outbound",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxBytes: number,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ): Promise<{ path: string; contentType?: string }>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mentions: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      buildMentionRegexes(cfg: OpenClawConfig, agentId?: string): RegExp[];（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      matchesMentionPatterns(text: string, regexes: RegExp[]): boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    groups: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      resolveGroupPolicy(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cfg: OpenClawConfig,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupId: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ): {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowlistEnabled: boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        allowed: boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupConfig?: unknown;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        defaultConfig?: unknown;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      resolveRequireMention(（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        cfg: OpenClawConfig,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        groupId: string,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        override?: boolean,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ): boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    debounce: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      createInboundDebouncer<T>(opts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        debounceMs: number;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        buildKey: (v: T) => string | null;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        shouldDebounce: (v: T) => boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        onFlush: (entries: T[]) => Promise<void>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        onError?: (err: unknown) => void;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }): { push: (v: T) => void; flush: () => Promise<void> };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      resolveInboundDebounceMs(cfg: OpenClawConfig, channel: string): number;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    commands: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      resolveCommandAuthorizedFromAuthorizers(params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        useAccessGroups: boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        authorizers: Array<{ configured: boolean; allowed: boolean }>;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      }): boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  logging: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    shouldLogVerbose(): boolean;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    getChildLogger(name: string): PluginLogger;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  state: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resolveStateDir(cfg: OpenClawConfig): string;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  };（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
};（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime is the only way to access core behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SDK is intentionally small and stable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each runtime method maps to an existing core implementation (no duplication).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Migration plan (phased, safe)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 0: scaffolding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Introduce `openclaw/plugin-sdk`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `api.runtime` to `OpenClawPluginApi` with the surface above.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Maintain existing imports during a transition window (deprecation warnings).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 1: bridge cleanup (low risk)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replace per-extension `core-bridge.ts` with `api.runtime`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Migrate BlueBubbles, Zalo, Zalo Personal first (already close).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remove duplicated bridge code.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 2: light direct-import plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Migrate Matrix to SDK + runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Validate onboarding, directory, group mention logic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 3: heavy direct-import plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Migrate MS Teams (largest set of runtime helpers).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure reply/typing semantics match current behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 4: iMessage pluginization（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Move iMessage into `extensions/imessage`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Replace direct core calls with `api.runtime`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Keep config keys, CLI behavior, and docs intact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Phase 5: enforcement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add lint rule / CI check: no `extensions/**` imports from `src/**`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add plugin SDK/version compatibility checks (runtime + SDK semver).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Compatibility and versioning（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SDK: semver, published, documented changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime: versioned per core release. Add `api.runtime.version`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins declare a required runtime range (e.g., `openclawRuntime: ">=2026.2.0"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Testing strategy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Adapter-level unit tests (runtime functions exercised with real core implementation).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Golden tests per plugin: ensure no behavior drift (routing, pairing, allowlist, mention gating).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A single end-to-end plugin sample used in CI (install + run + smoke).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Open questions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Where to host SDK types: separate package or core export?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runtime type distribution: in SDK (types only) or in core?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- How to expose docs links for bundled vs external plugins?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Do we allow limited direct core imports for in-repo plugins during transition?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Success criteria（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- All channel connectors are plugins using SDK + runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No `extensions/**` imports from `src/**`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- New connector templates depend only on SDK + runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- External plugins can be developed and updated without core source access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related docs: [Plugins](/tools/plugin), [Channels](/channels/index), [Configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
