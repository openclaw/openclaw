---
summary: "計畫：為所有訊息連接器提供一個乾淨的外掛 SDK + 執行階段"
read_when:
  - Defining or refactoring the plugin architecture
  - 將頻道連接器遷移至外掛 SDK／執行階段時
title: "refactor/plugin-sdk.md"
---

# 外掛 SDK + 執行階段重構計畫

Goal: every messaging connector is a plugin (bundled or external) using one stable API.
No plugin imports from `src/**` directly. All dependencies go through the SDK or runtime.

## Why now

- Current connectors mix patterns: direct core imports, dist-only bridges, and custom helpers.
- This makes upgrades brittle and blocks a clean external plugin surface.

## 目標架構（兩層）

### 1. Plugin SDK (compile-time, stable, publishable)

Scope: types, helpers, and config utilities. No runtime state, no side effects.

內容（範例）：

- 型別：`ChannelPlugin`、轉接器、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- 設定輔助工具：`buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、
  `applyAccountNameToChannelSection`。
- 配對輔助工具：`PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- 入門引導輔助工具：`promptChannelAccessConfig`、`addWildcardAllowFrom`、入門引導型別。
- 工具參數輔助工具：`createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- 文件連結輔助工具：`formatDocsLink`。

交付方式：

- 發佈為 `openclaw/plugin-sdk`（或在核心中以 `openclaw/plugin-sdk` 匯出）。
- Semver with explicit stability guarantees.

### 2. 外掛執行階段（執行介面，注入）

Scope: everything that touches core runtime behavior.
Accessed via `OpenClawPluginApi.runtime` so plugins never import `src/**`.

建議介面（精簡但完整）：

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

注意事項：

- Runtime is the only way to access core behavior.
- SDK 有意保持精簡且穩定。
- Each runtime method maps to an existing core implementation (no duplication).

## 遷移計畫（分階段、安全）

### 第 0 階段：腳手架

- 引入 `openclaw/plugin-sdk`。
- 將 `api.runtime` 加入 `OpenClawPluginApi`，並提供上述介面。
- 第 2 階段：輕量直接匯入外掛

### 第 1 階段：橋接清理（低風險）

- 以 `api.runtime` 取代各擴充套件的 `core-bridge.ts`。
- 先遷移 BlueBubbles、Zalo、Zalo Personal（已相當接近）。
- 移除重複的橋接程式碼。

### Phase 2: light direct-import plugins

- 將 Matrix 遷移至 SDK + 執行階段。
- Validate onboarding, directory, group mention logic.

### 確保回覆／輸入中的語意與目前行為一致。

- 遷移 MS Teams（執行階段輔助工具最多）。
- Ensure reply/typing semantics match current behavior.

### 第 4 階段：iMessage 外掛化

- 將 iMessage 移至 `extensions/imessage`。
- 以 `api.runtime` 取代直接核心呼叫。
- Keep config keys, CLI behavior, and docs intact.

### 第 5 階段：強制執行

- 新增 lint 規則／CI 檢查：`src/**` 不得匯入 `extensions/**`。
- Add plugin SDK/version compatibility checks (runtime + SDK semver).

## 相容性與版本管理

- SDK：Semver、已發佈、變更皆有文件。
- 新增 `api.runtime.version`。 Add `api.runtime.version`.
- 外掛宣告所需的執行階段版本範圍（例如 `openclawRuntime: ">=2026.2.0"`）。

## 測試策略

- Adapter-level unit tests (runtime functions exercised with real core implementation).
- 每個外掛的黃金測試：確保行為不漂移（路由、配對、允許清單、提及閘控）。
- CI 中使用單一端到端外掛範例（安裝 + 執行 + 冒煙測試）。

## 開放問題

- SDK 型別應放在哪裡：獨立套件或核心匯出？
- 執行階段型別的發佈方式：在 SDK 中（僅型別）或在核心中？
- 如何為內建外掛與外部外掛公開文件連結？
- 在過渡期間，是否允許在倉庫內的外掛有限度地直接匯入核心？

## 成功標準

- 所有頻道連接器皆為使用 SDK + 執行階段的外掛。
- `src/**` 不得匯入 `extensions/**`。
- 新的連接器範本僅相依於 SDK + 執行階段。
- 處理外掛設定結構或外掛載入門檻

相關文件：[Plugins](/tools/plugin)、[Channels](/channels/index)、[Configuration](/gateway/configuration)。
