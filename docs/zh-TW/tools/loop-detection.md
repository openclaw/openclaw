---
title: Tool-loop detection
description: >-
  Configure optional guardrails for preventing repetitive or stalled tool-call
  loops
summary: How to enable and tune guardrails that detect repetitive tool-call loops
read_when:
  - A user reports agents getting stuck repeating tool calls
  - You need to tune repetitive-call protection
  - You are editing agent tool/runtime policies
---

# 工具迴圈偵測

OpenClaw 可以防止代理程式陷入重複的工具呼叫模式。
此防護機制預設為**關閉**。

僅在必要時啟用，因為嚴格設定可能會阻擋合法的重複呼叫。

## 為什麼需要這個功能

- 偵測沒有進展的重複序列。
- 偵測高頻率無結果的迴圈（相同工具、相同輸入、重複錯誤）。
- 偵測已知輪詢工具的特定重複呼叫模式。

## 設定區塊

全域預設值：

```json5
{
  tools: {
    loopDetection: {
      enabled: false,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

每個代理程式覆寫（選用）：

```json5
{
  agents: {
    list: [
      {
        id: "safe-runner",
        tools: {
          loopDetection: {
            enabled: true,
            warningThreshold: 8,
            criticalThreshold: 16,
          },
        },
      },
    ],
  },
}
```

### 欄位行為

- `enabled`：主開關。`false` 表示不執行迴圈偵測。
- `historySize`：保留用於分析的近期工具呼叫數量。
- `warningThreshold`：將模式分類為僅警告的門檻值。
- `criticalThreshold`：阻擋重複迴圈模式的門檻值。
- `globalCircuitBreakerThreshold`：全域無進展中斷門檻。
- `detectors.genericRepeat`：偵測重複相同工具 + 相同參數的模式。
- `detectors.knownPollNoProgress`：偵測已知輪詢類似且無狀態變化的模式。
- `detectors.pingPong`：偵測交替乒乓模式。

## 推薦設定

- 從 `enabled: true` 開始，保持預設值不變。
- 門檻值依 `warningThreshold < criticalThreshold < globalCircuitBreakerThreshold` 排序。
- 若發生誤判：
  - 提高 `warningThreshold` 和／或 `criticalThreshold`
  - （選擇性）提高 `globalCircuitBreakerThreshold`
  - 僅停用造成問題的偵測器
  - 降低 `historySize` 以減少嚴格的歷史上下文

## 日誌與預期行為

當偵測到迴圈時，OpenClaw 會報告迴圈事件，並根據嚴重程度阻擋或抑制下一個工具週期。  
這可保護使用者避免代幣過度消耗和系統鎖死，同時維持正常的工具存取。

- 優先採用警告和暫時抑制。
- 僅在累積多次證據時才升級處理。

## 備註

- `tools.loopDetection` 與代理層級的覆寫設定合併。
- 每個代理的設定會完全覆寫或擴充全域值。
- 若無設定存在，防護措施將保持關閉。
