---
summary: "Plan: one clean plugin SDK + runtime for all messaging connectors"
read_when:
  - Defining or refactoring the plugin architecture
  - Migrating channel connectors to the plugin SDK/runtime
title: Plugin SDK Refactor
---

# Plugin SDK + 執行時重構計畫

目標：每個訊息連接器都是一個插件（內建或外部），使用統一且穩定的 API。
禁止插件直接從 `src/**` 匯入。所有依賴必須透過 SDK 或執行時取得。

## 為什麼現在要做

- 現有連接器混用多種模式：直接匯入核心、僅限發佈版的橋接，以及自訂輔助工具。
- 這導致升級困難且阻礙乾淨的外部插件介面。

## 目標架構（兩層）

### 1) Plugin SDK（編譯時、穩定、可發佈）

範圍：型別、輔助工具與設定工具。無執行時狀態，無副作用。

內容（範例）：

- 型別：`ChannelPlugin`、adapter、`ChannelMeta`、`ChannelCapabilities`、`ChannelDirectoryEntry`。
- 設定輔助工具：`buildChannelConfigSchema`、`setAccountEnabledInConfigSection`、`deleteAccountFromConfigSection`、`applyAccountNameToChannelSection`。
- 配對輔助工具：`PAIRING_APPROVED_MESSAGE`、`formatPairingApproveHint`。
- 新手引導輔助工具：`promptChannelAccessConfig`、`addWildcardAllowFrom`、新手引導型別。
- 工具參數輔助工具：`createActionGate`、`readStringParam`、`readNumberParam`、`readReactionParams`、`jsonResult`。
- 文件連結輔助工具：`formatDocsLink`。

交付方式：

- 發佈為 `openclaw/plugin-sdk`（或從核心以 `openclaw/plugin-sdk` 匯出）。
- 使用語義版本控制並明確保證穩定性。

### 2) Plugin 執行時（執行介面，注入式）

範圍：所有涉及核心執行時行為的功能。
透過 `OpenClawPluginApi.runtime` 存取，插件絕不直接匯入 `src/**`。

建議介面（最小但完整）：

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

備註：

- Runtime 是存取核心行為的唯一途徑。
- SDK 故意設計為小且穩定。
- 每個 runtime 方法都對應到現有的核心實作（無重複）。

## 遷移計畫（分階段、安全）

### 階段 0：架構搭建

- 引入 `openclaw/plugin-sdk`。
- 以上述介面新增 `api.runtime` 至 `OpenClawPluginApi`。
- 在過渡期間維持現有匯入（並顯示棄用警告）。

### 階段 1：橋接清理（低風險）

- 用 `api.runtime` 取代每個擴充的 `core-bridge.ts`。
- 先遷移 BlueBubbles、Zalo、Zalo Personal（已接近完成）。
- 移除重複的橋接程式碼。

### 階段 2：輕量直接匯入插件

- 將 Matrix 遷移至 SDK + runtime。
- 驗證加入流程、目錄、群組提及邏輯。

### 階段 3：重量級直接匯入插件

- 遷移 MS Teams（擁有最多 runtime 輔助函式）。
- 確保回覆/輸入狀態語意與現有行為一致。

### 階段 4：iMessage 插件化

- 將 iMessage 移入 `extensions/imessage`。
- 用 `api.runtime` 取代直接核心呼叫。
- 保持設定鍵、CLI 行為與文件不變。

### 階段 5：強制執行

- 新增 lint 規則 / CI 檢查：禁止從 `src/**` 匯入 `extensions/**`。
- 新增插件 SDK/版本相容性檢查（runtime + SDK semver）。

## 相容性與版本控制

- SDK：採用語義版本控制（semver），發布並記錄變更。
- 執行時環境：依核心版本發行。新增 `api.runtime.version`。
- 外掛需宣告所需的執行時版本範圍（例如 `openclawRuntime: ">=2026.2.0"`）。

## 測試策略

- 介面層級單元測試（使用真實核心實作測試執行時功能）。
- 每個外掛的黃金測試：確保行為無偏移（路由、配對、允許清單、提及門控）。
- CI 中使用單一端對端外掛範例（安裝 + 執行 + 簡易測試）。

## 未解決問題

- SDK 型別應該放在哪裡：獨立套件還是核心匯出？
- 執行時型別分發：放在 SDK（僅型別）還是核心？
- 如何對內建與外部外掛公開文件連結？
- 過渡期間是否允許倉庫內外掛有限度直接匯入核心？

## 成功標準

- 所有頻道連接器皆為使用 SDK + 執行時的外掛。
- 不得從 `src/**` 匯入 `extensions/**`。
- 新連接器範本僅依賴 SDK + 執行時。
- 外部外掛可在無核心原始碼存取下開發與更新。

相關文件：[外掛](/tools/plugin)、[頻道](/channels/index)、[設定](/gateway/configuration)。
