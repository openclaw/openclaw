---
summary: "OpenClaw 專案的測試策略與執行"
read_when:
  - 貢獻程式碼並需要執行測試時
  - 診斷測試失敗或環境問題時
  - 瞭解單元測試、E2E 測試與 Live 測試的區別時
title: "測試指南"
---

# 測試指南

本文件定義了 OpenClaw 專案的測試標準與流程。

## 快速開始

OpenClaw 使用 `vitest` 進行測試。

```bash
# 執行所有單元測試
pnpm test

# 執行 E2E 測試 (需要本地 Gateway 環境)
pnpm test:e2e

# 執行特定檔案的測試
pnpm vitest path/to/test.ts
```

## 測試類型

### 1. 單元測試 (Unit Tests)

主要測試邏輯、工具與輔助函數。不依賴外部 API 或網路。

### 2. E2E 測試 (End-to-End)

測試完整的訊息流、閘道配對與協議。通常會啟動一個模擬的 Gateway。

### 3. Live 測試 (Live Tests)

與真實的提供者 (OpenAI, Anthropic) 或硬體節點 (Android, iOS) 進行互動。需要有效的 API Key 或已連接的裝置。

---

## 實機測試：Android 節點功能掃描

- **測試路徑**：`src/gateway/android-node.capabilities.live.test.ts`
- **指令**：`pnpm android:test:integration`
- **目標**：呼叫 Android 節點目前宣告的 **每一個指令**，並驗證指令契約行為。
- **範圍**：
  - 預設/手動設定（測試組件不會自動安裝/執行/配對應用程式）。
  - 對所選 Android 節點進行逐項指令的 `node.invoke` 驗證。
- **前置作業**：
  - Android 應用程式已連接並與 Gateway 配對。
  - 應用程式保持在前台執行。
  - 已授權預期通過功能所需的權限/擷取許可。
- **選用目標覆蓋**：
  - `OPENCLAW_ANDROID_NODE_ID` 或 `OPENCLAW_ANDROID_NODE_NAME`。
  - `OPENCLAW_ANDROID_GATEWAY_URL` / `OPENCLAW_ANDROID_GATEWAY_TOKEN` / `OPENCLAW_ANDROID_GATEWAY_PASSWORD`。
- **完整 Android 設定詳情**：[Android App](/platforms/android)

---

## 故障排除

如果測試失敗：

1. 檢查 `.env` 檔案中是否缺少必要的 API Key。
2. 確保 Gateway 已啟動（若執行 E2E 測試）。
3. 使用 `--ui` 模式觀察 Vitest 的詳細報錯資訊。
