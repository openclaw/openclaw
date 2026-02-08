---
summary: "計畫：為所有訊息連接器提供一個乾淨的外掛 SDK + 執行階段"
read_when:
  - 定義或重構外掛架構時
  - 將頻道連接器遷移至外掛 SDK／執行階段時
title: "外掛 SDK 重構"
x-i18n:
  source_path: refactor/plugin-sdk.md
  source_hash: 1f3519f43632fcac
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:10Z
---

# 外掛 SDK + 執行階段重構計畫

目標：每個訊息連接器都是一個外掛（內建或外部），並使用單一穩定 API。
任何外掛都不得直接從 `src/**` 匯入。所有相依性都必須透過 SDK 或執行階段。

## 為什麼現在要做

- 目前的連接器混用了多種模式：直接核心匯入、僅 dist 的橋接，以及自訂輔助工具。
- 這讓升級變得脆弱，並阻礙了乾淨的外部外掛介面。

## 目標架構（兩層）

### 1) 外掛 SDK（編譯期、穩定、可發佈）

範圍：型別、輔助工具與設定工具。沒有執行階段狀態，沒有副作用。

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
- 採用語意化版本（Semver），並提供明確的穩定性保證。

### 2) 外掛執行階段（執行介面，注入）

範圍：所有會觸及核心執行階段行為的項目。
透過 `OpenClawPluginApi.runtime` 存取，因此外掛永遠不會匯入 `src/**`。

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

- 執行階段是存取核心行為的唯一方式。
- SDK 有意保持精簡且穩定。
- 每個執行階段方法都對應到既有的核心實作（不重複）。

## 遷移計畫（分階段、安全）

### 第 0 階段：腳手架

- 引入 `openclaw/plugin-sdk`。
- 將 `api.runtime` 加入 `OpenClawPluginApi`，並提供上述介面。
- 在過渡期間維持既有匯入（顯示棄用警告）。

### 第 1 階段：橋接清理（低風險）

- 以 `api.runtime` 取代各擴充套件的 `core-bridge.ts`。
- 先遷移 BlueBubbles、Zalo、Zalo Personal（已相當接近）。
- 移除重複的橋接程式碼。

### 第 2 階段：輕量直接匯入的外掛

- 將 Matrix 遷移至 SDK + 執行階段。
- 驗證入門引導、目錄與群組提及邏輯。

### 第 3 階段：大量直接匯入的外掛

- 遷移 MS Teams（執行階段輔助工具最多）。
- 確保回覆／輸入中語意與目前行為一致。

### 第 4 階段：iMessage 外掛化

- 將 iMessage 移至 `extensions/imessage`。
- 以 `api.runtime` 取代直接核心呼叫。
- 保持設定金鑰、CLI 行為與文件不變。

### 第 5 階段：強制執行

- 新增 lint 規則／CI 檢查：`src/**` 不得匯入 `extensions/**`。
- 新增外掛 SDK／版本相容性檢查（執行階段 + SDK 的 Semver）。

## 相容性與版本管理

- SDK：Semver、已發佈、變更皆有文件。
- 執行階段：每個核心版本各自版本化。新增 `api.runtime.version`。
- 外掛宣告所需的執行階段版本範圍（例如 `openclawRuntime: ">=2026.2.0"`）。

## 測試策略

- 轉接器層級的單元測試（以真實核心實作驗證執行階段函式）。
- 每個外掛的黃金測試：確保行為不漂移（路由、配對、允許清單、提及閘控）。
- CI 中使用單一端到端外掛範例（安裝 + 執行 + 冒煙測試）。

## 開放問題

- SDK 型別應放在哪裡：獨立套件或核心匯出？
- 執行階段型別的發佈方式：在 SDK 中（僅型別）或在核心中？
- 如何為內建與外部外掛暴露文件連結？
- 在過渡期間，是否允許在倉庫內的外掛有限度地直接匯入核心？

## 成功標準

- 所有頻道連接器皆為使用 SDK + 執行階段的外掛。
- `src/**` 不得匯入 `extensions/**`。
- 新的連接器範本僅相依於 SDK + 執行階段。
- 外部外掛可在不存取核心原始碼的情況下開發與更新。

相關文件：[Plugins](/tools/plugin)、[Channels](/channels/index)、[Configuration](/gateway/configuration)。
