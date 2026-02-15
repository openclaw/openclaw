---
summary: "節點的位置指令 (location.get)、權限模式和背景行為"
read_when:
  - 新增位置節點支援或權限使用者介面時
  - 設計背景位置 + 推播流程時
title: "位置指令"
---

# 位置指令 (節點)

## 摘要 (TL;DR)

- `location.get` 是一個節點指令 (透過 `node.invoke`)。
- 預設為關閉。
- 設定使用選擇器：關閉 / 使用期間 / 永遠。
- 獨立開關：精確位置。

## 為何使用選擇器 (而不僅是開關)

作業系統權限是多層級的。我們可以在應用程式內公開一個選擇器，但作業系統仍會決定實際的授權。

- iOS/macOS：使用者可以在系統提示/設定中選擇「**使用期間**」或「**永遠**」。應用程式可以請求升級，但作業系統可能需要進入設定。
- Android：背景位置是獨立的權限；在 Android 10+ 上，它通常需要一個設定流程。
- 精確位置是獨立的授權 (iOS 14+「精確」，Android「精確」與「粗略」)。

使用者介面中的選擇器驅動我們請求的模式；實際的授權存在於作業系統設定中。

## 設定模型

每個節點裝置：

- `location.enabledMode`：`off | whileUsing | always`
- `location.preciseEnabled`：布林值

使用者介面行為：

- 選擇「`whileUsing`」會請求前景權限。
- 選擇「`always`」首先會確保「`whileUsing`」，然後請求背景權限 (如果需要，則將使用者導向設定)。
- 如果作業系統拒絕請求的層級，則恢復到最高已授權層級並顯示狀態。

## 權限映射 (node.permissions)

選填。macOS 節點透過權限映射回報 `location`；iOS/Android 可能會省略它。

## 指令：`location.get`

透過 `node.invoke` 呼叫。

參數 (建議)：

```json
{
  "timeoutMs": 10000,
  "maxAgeMs": 15000,
  "desiredAccuracy": "coarse|balanced|precise"
}
```

回應酬載：

```json
{
  "lat": 48.20849,
  "lon": 16.37208,
  "accuracyMeters": 12.5,
  "altitudeMeters": 182.0,
  "speedMps": 0.0,
  "headingDeg": 270.0,
  "timestamp": "2026-01-03T12:34:56.000Z",
  "isPrecise": true,
  "source": "gps|wifi|cell|unknown"
}
```

錯誤 (穩定代碼)：

- `LOCATION_DISABLED`：選擇器已關閉。
- `LOCATION_PERMISSION_REQUIRED`：請求模式缺少權限。
- `LOCATION_BACKGROUND_UNAVAILABLE`：應用程式在背景執行，但僅允許「使用期間」。
- `LOCATION_TIMEOUT`：未能在時間內定位。
- `LOCATION_UNAVAILABLE`：系統故障 / 無提供者。

## 背景行為 (未來)

目標：即使節點在背景執行，模型也能請求位置，但僅限於以下情況：

- 使用者選擇「**永遠**」。
- 作業系統授予背景位置權限。
- 應用程式被允許在背景執行以獲取位置 (iOS 背景模式 / Android 前景服務或特殊允許)。

推播觸發流程 (未來)：

1. Gateway 向節點傳送推播 (靜默推播或 FCM 資料)。
2. 節點短暫喚醒並向裝置請求位置。
3. 節點將酬載轉傳給 Gateway。

注意事項：

- iOS：需要「永遠」權限 + 背景位置模式。靜默推播可能會被限制；預期會間歇性失敗。
- Android：背景位置可能需要前景服務；否則，預期會被拒絕。

## 模型/工具整合

- 工具介面：`nodes` 工具新增 `location_get` 動作 (需要節點)。
- CLI：`openclaw nodes location get --node <id>`。
- 智慧代理準則：僅當使用者啟用位置並了解範圍時才呼叫。

## 使用者體驗文案 (建議)

- 關閉：「位置分享已停用。」
- 使用期間：「僅限 OpenClaw 開啟時。」
- 永遠：「允許背景位置。需要系統權限。」
- 精確：「使用精確的 GPS 位置。關閉此開關以分享大約位置。」
