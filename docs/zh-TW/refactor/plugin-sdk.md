---
summary: "計畫：適用於所有通訊連接器的單一且乾淨的 plugin SDK + runtime"
read_when:
  - 定義或重構 plugin 架構時
  - 將頻道連接器遷移至 plugin SDK/runtime 時
title: "Plugin SDK 重構"
---

# Plugin SDK + Runtime 重構計畫

目標：使每個通訊連接器都成為使用單一穩定 API 的 plugin（內建或外部）。
Plugin 不得直接從 `src/**` 匯入。所有相依性都必須透過 SDK 或 runtime 進行。

## 為什麼現在要這麼做

- 目前的連接器混合了多種模式：直接從核心匯入、僅限 dist 的橋接以及自訂輔助函式。
- 這使得升級變得脆弱，並阻礙了建立乾淨的外部 plugin 介面。

## 目標架構（兩層）

### 1) Plugin SDK（編譯時，穩定，可發佈）

範圍：型別、輔助函式與設定公用程式。無 runtime 狀態，無副作用。

內容（範例）：

- 型別：`ChannelPlugin`、轉接器、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- 設定輔助函式：`buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、`applyAccountNameToChannelSection`。
- 配對輔助函式：`PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- 新手導覽輔助函式：`promptChannelAccessConfig`、`addWildcardAllowFrom`、新手導覽型別。
- 工具參數輔助函式：`createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- 文件連結輔助函式：`formatDocsLink`。

發佈方式：

- 以 `openclaw/plugin-sdk` 發佈（或從核心的 `openclaw/plugin-sdk` 匯出）。
- 具備明確穩定性保證的語義化版本 (Semver)。

### 2) Plugin Runtime（執行層，注入式）

範圍：所有涉及核心 runtime 行為的部分。
透過 `OpenClawPluginApi.runtime` 存取，確保 plugin 永不匯入 `src/**`。

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
      createReplyDispatcherWithTyping?: unknown; // Teams 風格流程的轉接器
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

備註：

- Runtime 是存取核心行為的唯一管道。
- SDK 刻意保持精簡且穩定。
- 每個 runtime 方法都對應到現有的核心實作（無重複）。

## 遷移計畫（分階段、安全）

### 階段 0：架構搭建

- 引入 `openclaw/plugin-sdk`。
- 將上述介面新增至 `OpenClawPluginApi` 的 `api.runtime`。
- 在過渡期間維持現有匯入（顯示棄用警告）。

### 階段 1：清理橋接（低風險）

- 以 `api.runtime` 取代各個擴充功能的 `core-bridge.ts`。
- 先遷移 BlueBubbles、Zalo、Zalo Personal（目前已接近完成）。
- 移除重複的橋接程式碼。

### 階段 2：輕量級直接匯入 plugin

- 將 Matrix 遷移至 SDK + runtime。
- 驗證新手導覽、目錄、群組提及邏輯。

### 階段 3：重量級直接匯入 plugin

- 遷移 MS Teams（包含最多 runtime 輔助函式）。
- 確保回覆/正在輸入語義與目前行為一致。

### 階段 4：iMessage plugin 化

- 將 iMessage 移至 `extensions/imessage`。
- 以 `api.runtime` 取代直接的核心呼叫。
- 保持設定鍵名、CLI 行為和文件完整。

### 階段 5：強制執行

- 新增 lint 規則 / CI 檢查：禁止從 `src/**` 匯入 `extensions/**`。
- 新增 plugin SDK/版本相容性檢查（runtime + SDK semver）。

## 相容性與版本控制

- SDK：語義化版本、已發佈、記錄變更。
- Runtime：依核心版本進行版本控制。新增 `api.runtime.version`。
- Plugin 宣告所需的 runtime 範圍（例如：`openclawRuntime: ">=2026.2.0"`）。

## 測試策略

- 轉接器層級的單元測試（使用真實核心實作執行 runtime 函式）。
- 每個 plugin 的基準測試 (Golden tests)：確保行為無偏差（路由、配對、允許清單、提及過濾）。
- CI 中使用單一端對端 plugin 範例（安裝 + 執行 + 冒煙測試）。

## 開放性問題

- SDK 型別存放位置：獨立套件還是從核心匯出？
- Runtime 型別分發：在 SDK 中（僅限型別）還是在核心中？
- 如何顯示內建與外部 plugin 的文件連結？
- 在過渡期間是否允許存放庫內的 plugin 進行有限度的直接核心匯入？

## 成功準則

- 所有頻道連接器皆為使用 SDK + runtime 的 plugin。
- 無從 `src/**` 匯入 `extensions/**` 的情況。
- 新的連接器範本僅依賴於 SDK + runtime。
- 無需存取核心原始碼即可開發和更新外部 plugin。

相關文件：[Plugins](/tools/plugin), [Channels](/channels/index), [設定](/gateway/configuration)。
