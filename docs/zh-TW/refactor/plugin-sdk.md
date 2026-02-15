---
summary: "規劃：一個用於所有訊息連接器的乾淨外掛程式 SDK + 執行時環境"
read_when:
  - 定義或重構外掛程式架構
  - 將頻道連接器遷移至外掛程式 SDK/執行時環境
title: "外掛程式 SDK 重構"
---

# 外掛程式 SDK + 執行時重構規劃

目標：每個訊息連接器都是一個使用穩定 API 的外掛程式（無論是捆綁的還是外部的）。
沒有外掛程式直接從 `src/**` 匯入。所有依賴項都透過 SDK 或執行時環境。

## 為何是現在

- 目前的連接器混合了多種模式：直接核心匯入、僅限 dist 的橋接器以及自訂輔助程式。
- 這使得升級變得脆弱，並阻礙了乾淨的外部外掛程式介面。

## 目標架構（兩層）

### 1) 外掛程式 SDK (編譯時、穩定、可發布)

範圍：型別、輔助程式和設定公用程式。沒有執行時狀態，沒有副作用。

內容（範例）：

- 型別：`ChannelPlugin`、adapters、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- 設定輔助程式：`buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、
  `applyAccountNameToChannelSection`。
- 配對輔助程式：`PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- 新手導覽輔助程式：`promptChannelAccessConfig`、`addWildcardAllowFrom`、新手導覽型別。
- 工具參數輔助程式：`createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- 文件連結輔助程式：`formatDocsLink`。

交付：

- 發布為 `openclaw/plugin-sdk`（或從核心匯出為 `openclaw/plugin-sdk`）。
- 語意版本控制 (Semver) 附帶明確的穩定性保證。

### 2) 外掛程式執行時環境 (執行介面，注入式)

範圍：所有涉及核心執行時行為的事物。
透過 `OpenClawPluginApi.runtime` 存取，因此外掛程式永遠不會匯入 `src/**`。

提議的介面（最小但完整）：

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

注意事項：

- 執行時環境是存取核心行為的唯一途徑。
- SDK 刻意保持小巧且穩定。
- 每個執行時方法都對應到現有的核心實作（沒有重複）。

## 遷移規劃（分階段，安全）

### 階段 0：基礎建構

- 引入 `openclaw/plugin-sdk`。
- 將 `api.runtime` 新增至 `OpenClawPluginApi`，其介面如上。
- 在過渡期間保留現有匯入（棄用警告）。

### 階段 1：橋接器清理（低風險）

- 將每個擴充功能的 `core-bridge.ts` 替換為 `api.runtime`。
- 首先遷移 BlueBubbles、Zalo、Zalo Personal（已接近完成）。
- 移除重複的橋接器程式碼。

### 階段 2：輕量級直接匯入外掛程式

- 將 Matrix 遷移至 SDK + 執行時環境。
- 驗證新手導覽、目錄、群組提及邏輯。

### 階段 3：重量級直接匯入外掛程式

- 遷移 MS Teams（最大的執行時輔助程式集）。
- 確保回覆/打字語義與當前行為相符。

### 階段 4：iMessage 外掛程式化

- 將 iMessage 移至 `extensions/imessage`。
- 將直接的核心呼叫替換為 `api.runtime`。
- 保持設定鍵名、CLI 行為和文件不變。

### 階段 5：強制執行

- 新增 lint 規則 / CI 檢查：不允許 `extensions/**` 從 `src/**` 匯入。
- 新增外掛程式 SDK/版本相容性檢查（執行時 + SDK 語意版本）。

## 相容性與版本控制

- SDK：語意版本控制、已發布、記錄變更。
- 執行時環境：按核心版本發布版本。新增 `api.runtime.version`。
- 外掛程式聲明所需的執行時版本範圍（例如：`openclawRuntime: ">=2026.2.0"`）。

## 測試策略

- 轉接器層級單元測試（使用實際核心實作來執行執行時函數）。
- 每個外掛程式的黃金測試：確保行為沒有偏差（路由、配對、允許清單、提及閘門）。
- CI 中使用單個端對端外掛程式範例（安裝 + 執行 + 冒煙測試）。

## 待解決問題

- SDK 型別託管在哪裡：獨立套件還是核心匯出？
- 執行時型別分發：在 SDK 中（僅型別）還是核心中？
- 如何為捆綁的外掛程式和外部外掛程式公開文件連結？
- 在過渡期間，我們是否允許庫內外掛程式有限地直接核心匯入？

## 成功標準

- 所有頻道連接器都是使用 SDK + 執行時環境的外掛程式。
- 沒有 `extensions/**` 從 `src/**` 匯入。
- 新的連接器範本僅依賴於 SDK + 執行時環境。
- 外部外掛程式可以在無需存取核心原始碼的情況下進行開發和更新。

相關文件：[Plugins](/tools/plugin)、[Channels](/channels/index)、[Configuration](/gateway/configuration)。
